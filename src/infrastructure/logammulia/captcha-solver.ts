import { Page } from 'playwright';
import { execFile } from 'child_process';
import path from 'path';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

const RECAPTCHA_ANCHOR = '#recaptcha-anchor';
const RECAPTCHA_CHECKED = '#recaptcha-anchor[aria-checked="true"]';
const AUDIO_BTN = '#recaptcha-audio-button';
const AUDIO_DOWNLOAD_LINK = '.rc-audiochallenge-tdownload-link';
const AUDIO_RESPONSE_INPUT = '#audio-response';
const VERIFY_BTN = '#recaptcha-verify-button';
const CAPTCHA_RESPONSE_TEXTAREA = '#g-recaptcha-response';

const PYTHON_SOLVER_PATH = path.resolve(__dirname, '../../../scripts/solve-captcha.py');

/**
 * Attempts to solve reCAPTCHA on the current page.
 *
 * Strategy:
 * 1. Stealth plugin (auto-pass)
 * 2. Audio challenge + Python local STT (free, no API key)
 * 3. Audio challenge + Wit.ai (fallback if Python fails)
 * 4. Manual solve (if headless=false)
 */
export async function solveRecaptchaIfPresent(
  page: Page,
  witAiToken: string | undefined,
  headless: boolean,
): Promise<void> {
  const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
  if ((await recaptchaFrame.locator(RECAPTCHA_ANCHOR).count()) === 0) {
    return;
  }

  logger.info('[CAPTCHA] reCAPTCHA detected — attempting auto-solve...');

  // Tier 1: Click checkbox and hope stealth passes
  try {
    await recaptchaFrame.locator(RECAPTCHA_ANCHOR).click({ timeout: 10_000 });
  } catch (err) {
    logger.warn('[CAPTCHA] Could not click reCAPTCHA anchor:', err);
    return;
  }

  await sleep(3_000);

  if ((await recaptchaFrame.locator(RECAPTCHA_CHECKED).count()) > 0) {
    logger.info('[CAPTCHA] ✓ Solved without challenge (stealth auto-pass)');
    return;
  }

  // Tier 2: Audio challenge via Python local STT (free Google Web Speech API)
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`[CAPTCHA] Audio challenge attempt ${attempt}/${maxRetries} (Python STT)...`);
      const audioUrl = await getAudioChallengeUrl(page);
      if (!audioUrl) break;

      const transcript = await solveCaptchaWithPython(audioUrl);
      if (transcript) {
        await fillAndVerifyAudio(page, transcript);
        await sleep(2_500);
        if ((await recaptchaFrame.locator(RECAPTCHA_CHECKED).count()) > 0) {
          logger.info('[CAPTCHA] ✓ Solved via audio challenge + Python STT');
          return;
        }
        logger.warn(`[CAPTCHA] Python STT attempt ${attempt}: submitted but not verified`);
      } else {
        logger.warn(`[CAPTCHA] Python STT attempt ${attempt}: empty transcript`);
      }
      await sleep(2_000);
    } catch (err) {
      logger.error(`[CAPTCHA] Python STT attempt ${attempt} failed:`, err);
      if (attempt < maxRetries) await sleep(2_000);
    }
  }

  // Tier 3: Audio challenge via Wit.ai (fallback)
  if (witAiToken) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`[CAPTCHA] Audio challenge attempt ${attempt}/${maxRetries} (Wit.ai)...`);
        await solveAudioChallenge(page, witAiToken);
        await sleep(2_500);
        if ((await recaptchaFrame.locator(RECAPTCHA_CHECKED).count()) > 0) {
          logger.info('[CAPTCHA] ✓ Solved via audio challenge + Wit.ai');
          return;
        }
        logger.warn(`[CAPTCHA] Wit.ai attempt ${attempt}: submitted but not verified`);
        await sleep(2_000);
      } catch (err) {
        logger.error(`[CAPTCHA] Wit.ai attempt ${attempt} failed:`, err);
        if (attempt < maxRetries) {
          try {
            await recaptchaFrame.locator(RECAPTCHA_ANCHOR).click({ timeout: 5_000 });
            await sleep(2_000);
          } catch { /* ignore */ }
        }
      }
    }
    logger.warn('[CAPTCHA] All audio challenge attempts exhausted');
  }

  // Tier 4: Manual fallback
  if (headless) {
    throw new Error('[CAPTCHA] Cannot solve in headless mode - all auto-solve methods failed');
  }

  logger.info('[CAPTCHA] Waiting up to 2 minutes for manual solve...');
  try {
    await page.waitForFunction(
      (selector) => {
        const el = document.querySelector(selector) as HTMLTextAreaElement | null;
        return el !== null && el.value.length > 0;
      },
      CAPTCHA_RESPONSE_TEXTAREA,
      { timeout: 120_000 },
    );
    logger.info('[CAPTCHA] ✓ reCAPTCHA solved manually');
  } catch {
    throw new Error('[CAPTCHA] Timed out waiting for manual solve');
  }
}

/**
 * Extracts the audio challenge URL from the reCAPTCHA challenge frame.
 */
async function getAudioChallengeUrl(page: Page): Promise<string | null> {
  const challengeFrame = page.frameLocator('iframe[title*="recaptcha challenge"]');

  // Click audio button if needed
  try {
    const audioBtn = challengeFrame.locator(AUDIO_BTN);
    if ((await audioBtn.count()) > 0) {
      await audioBtn.click({ timeout: 5_000 });
      await sleep(3_000);
    }
  } catch { /* may already be on audio tab */ }

  // Get audio URL
  let audioUrl: string | null = null;
  try {
    audioUrl = await challengeFrame
      .locator(AUDIO_DOWNLOAD_LINK)
      .getAttribute('href', { timeout: 10_000 });
  } catch {
    try {
      audioUrl = await challengeFrame
        .locator('audio source')
        .getAttribute('src', { timeout: 5_000 });
    } catch { /* noop */ }
  }

  if (!audioUrl) {
    try {
      const errorText = await challengeFrame
        .locator('.rc-doscaptcha-header-text, .rc-audiochallenge-error-message')
        .textContent({ timeout: 3_000 });
      if (errorText) {
        logger.warn(`[CAPTCHA] Google blocked audio: "${errorText.trim()}"`);
      }
    } catch { /* ignore */ }
  }

  return audioUrl;
}

/**
 * Calls the Python STT script to transcribe a reCAPTCHA audio challenge.
 * Returns the transcript or null on failure.
 */
function solveCaptchaWithPython(audioUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'python',
      [PYTHON_SOLVER_PATH, audioUrl],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          logger.warn(`[CAPTCHA] Python solver error: ${stderr || error.message}`);
          resolve(null);
          return;
        }
        const transcript = stdout.trim().toLowerCase();
        if (transcript) {
          logger.info(`[CAPTCHA] Python STT transcript: "${transcript}"`);
          resolve(transcript);
        } else {
          logger.warn(`[CAPTCHA] Python solver returned empty. stderr: ${stderr}`);
          resolve(null);
        }
      },
    );
  });
}

/**
 * Fills the audio response input and clicks verify.
 */
async function fillAndVerifyAudio(page: Page, transcript: string): Promise<void> {
  const challengeFrame = page.frameLocator('iframe[title*="recaptcha challenge"]');
  await challengeFrame.locator(AUDIO_RESPONSE_INPUT).fill(transcript);
  await sleep(500);
  await challengeFrame.locator(VERIFY_BTN).click();
}

async function solveAudioChallenge(page: Page, witAiToken: string): Promise<void> {
  const challengeFrame = page.frameLocator('iframe[title*="recaptcha challenge"]');

  await sleep(2_000);

  try {
    const frameContent = await page.frames().find(f => f.url().includes('recaptcha'))?.content();
    if (frameContent) {
      const hasDenyMessage = frameContent.includes('Try again later') || frameContent.includes('automated queries');
      if (hasDenyMessage) {
        throw new Error('[CAPTCHA] Google detected automated queries — IP may be rate-limited');
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('Google detected')) throw err;
  }

  let audioClicked = false;
  for (let i = 0; i < 3; i++) {
    try {
      const audioBtn = challengeFrame.locator(AUDIO_BTN);
      if ((await audioBtn.count()) > 0) {
        await audioBtn.click({ timeout: 5_000 });
        audioClicked = true;
        break;
      }
      await sleep(1_000);
    } catch {
      audioClicked = true;
      break;
    }
  }

  if (!audioClicked) {
    throw new Error('[CAPTCHA] Could not find or click audio button');
  }

  await sleep(3_000);

  let audioUrl: string | null = null;
  try {
    audioUrl = await challengeFrame
      .locator(AUDIO_DOWNLOAD_LINK)
      .getAttribute('href', { timeout: 15_000 });
  } catch {
    try {
      audioUrl = await challengeFrame
        .locator('audio source')
        .getAttribute('src', { timeout: 5_000 });
    } catch { /* noop */ }
  }

  if (!audioUrl) {
    try {
      const errorText = await challengeFrame.locator('.rc-doscaptcha-header-text, .rc-audiochallenge-error-message').textContent({ timeout: 3_000 });
      if (errorText) {
        throw new Error(`[CAPTCHA] Google blocked audio challenge: "${errorText.trim()}"`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes('Google blocked')) throw e;
    }
    throw new Error('[CAPTCHA] Audio download link not found');
  }

  logger.info(`[CAPTCHA] Downloading audio challenge...`);
  const audioRes = await fetch(audioUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  if (!audioRes.ok) {
    throw new Error(`[CAPTCHA] Failed to download audio: ${audioRes.status}`);
  }
  const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

  logger.info('[CAPTCHA] Sending audio to Wit.ai for transcription...');
  const witRes = await fetch('https://api.wit.ai/speech?v=20220622', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${witAiToken}`,
      'Content-Type': 'audio/mpeg3',
      Accept: 'application/json',
    },
    body: audioBuffer,
  });

  if (!witRes.ok) {
    const errBody = await witRes.text().catch(() => '');
    throw new Error(`[CAPTCHA] Wit.ai error ${witRes.status}: ${errBody}`);
  }

  const rawBody = await witRes.text();
  const lines = rawBody.split('\n').filter((l) => l.trim().startsWith('{'));
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    throw new Error(`[CAPTCHA] Wit.ai returned unexpected format: ${rawBody.slice(0, 200)}`);
  }

  const witData = JSON.parse(lastLine) as { text?: string };
  const transcription = witData.text?.toLowerCase().trim();

  if (!transcription) {
    throw new Error('[CAPTCHA] Wit.ai returned empty transcription');
  }

  logger.info(`[CAPTCHA] Wit.ai transcription: "${transcription}"`);

  await challengeFrame.locator(AUDIO_RESPONSE_INPUT).fill(transcription);
  await sleep(500);
  await challengeFrame.locator(VERIFY_BTN).click();
}
