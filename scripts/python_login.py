"""
Auto-login to www.logammulia.com using DrissionPage + reCAPTCHA bypass.

Approach (proven from antam-new project):
- DrissionPage with persistent profile (Google trusts browsers with history)
- Comprehensive anti-detection JS injection
- Human-like delays + mouse movement
- Audio challenge fallback if checkbox doesn't auto-pass
- Export cookies to Playwright storage_state JSON format

Usage:
    python python_login.py [--profile-dir DIR] [--session-out PATH] [--headless]

Outputs:
    Writes Playwright-compatible session.json to --session-out path.
    Exit 0 on success, non-zero on failure.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Optional

try:
    from DrissionPage import ChromiumPage, ChromiumOptions
except ImportError:
    print("Missing DrissionPage. Install: pip install DrissionPage", file=sys.stderr)
    sys.exit(2)

LOGIN_URL = "https://www.logammulia.com/id/login"
PURCHASE_URL = "https://www.logammulia.com/id/purchase/gold"


def _stealth_js() -> str:
    """Comprehensive anti-detection JavaScript (from antam-new browser.py)."""
    return """
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined, configurable: true});
        try { delete navigator.__proto__.webdriver; } catch(e) {}

        Object.defineProperty(navigator, 'plugins', {
            get: () => {
                const p = [
                    {name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer'},
                    {name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
                    {name: 'Native Client', filename: 'internal-nacl-plugin'}
                ];
                p.length = 3;
                return p;
            }
        });

        Object.defineProperty(navigator, 'languages', {get: () => ['id-ID', 'id', 'en-US', 'en']});
        Object.defineProperty(navigator, 'language', {get: () => 'id-ID'});
        Object.defineProperty(navigator, 'platform', {get: () => 'Win32'});
        Object.defineProperty(navigator, 'vendor', {get: () => 'Google Inc.'});
        Object.defineProperty(navigator, 'hardwareConcurrency', {get: () => 8});
        Object.defineProperty(navigator, 'deviceMemory', {get: () => 8});

        window.chrome = {
            runtime: { connect: function() {}, sendMessage: function() {} },
            loadTimes: function() {
                return {
                    requestTime: Date.now() / 1000 - 1,
                    startLoadTime: Date.now() / 1000 - 0.5,
                    firstPaintTime: Date.now() / 1000 - 0.3,
                    finishLoadTime: Date.now() / 1000
                };
            }
        };

        const origQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => {
            if (parameters.name === 'notifications') {
                return Promise.resolve({state: 'prompt', onchange: null});
            }
            return origQuery ? origQuery(parameters) : Promise.resolve({state: 'prompt'});
        };

        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
        delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;

        Object.defineProperty(screen, 'width', {get: () => 1366});
        Object.defineProperty(screen, 'height', {get: () => 768});
        Object.defineProperty(screen, 'availWidth', {get: () => 1366});
        Object.defineProperty(screen, 'availHeight', {get: () => 728});
    """


def make_browser(profile_dir: str, headless: bool = False) -> ChromiumPage:
    """Create browser with anti-detection settings."""
    Path(profile_dir).mkdir(parents=True, exist_ok=True)

    options = ChromiumOptions()
    options.set_argument(f'--user-data-dir={profile_dir}')

    user_agent = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    )
    options.set_argument(f'--user-agent={user_agent}')
    options.set_argument('--disable-blink-features=AutomationControlled')
    options.set_argument('--excludeSwitches=enable-automation')
    options.set_argument('--useAutomationExtension=false')
    options.set_argument('--no-first-run')
    options.set_argument('--no-default-browser-check')
    options.set_argument('--disable-popup-blocking')
    options.set_argument('--lang=id-ID,id,en-US,en')
    options.set_argument('--window-size=1366,768')
    options.set_argument('--enable-webgl')
    options.set_argument('--enable-gpu')

    if headless:
        options.set_argument('--headless=new')
        options.set_argument('--disable-gpu')
        options.set_argument('--no-sandbox')
    else:
        # Hide window off-screen for unattended runs
        options.set_argument('--window-position=-2000,-2000')

    driver = ChromiumPage(options)
    try:
        driver.run_js(_stealth_js())
    except Exception:
        pass
    return driver


def is_solved(driver) -> bool:
    """Check if reCAPTCHA token is set."""
    try:
        token = driver.run_js("""
            var resp = document.getElementById("g-recaptcha-response");
            return resp ? resp.value : null;
        """)
        return bool(token and len(str(token)) > 50)
    except Exception:
        return False


def click_recaptcha_checkbox(driver, timeout: int = 15) -> bool:
    """Click the reCAPTCHA checkbox with human-like behavior."""
    try:
        iframe = (
            driver.ele("@title=reCAPTCHA", timeout=3) or
            driver.ele("css:iframe[src*='recaptcha']", timeout=2)
        )
        if not iframe:
            return False

        time.sleep(random.uniform(1.0, 3.0))  # Human pause to "see" the checkbox

        checkbox = (
            iframe.ele(".recaptcha-checkbox-border", timeout=2) or
            iframe.ele("#recaptcha-anchor", timeout=2)
        )
        if not checkbox:
            return False

        time.sleep(random.uniform(0.2, 0.5))
        checkbox.click()

        # Wait up to `timeout` seconds for verification
        for _ in range(timeout):
            time.sleep(random.uniform(0.8, 1.5))
            if is_solved(driver):
                return True
            try:
                cb = iframe.ele(".recaptcha-checkbox", timeout=0.5)
                if cb and cb.attr('aria-checked') == 'true':
                    time.sleep(random.uniform(0.5, 1.0))
                    if is_solved(driver):
                        return True
            except Exception:
                pass
            # If challenge popup appeared, checkbox alone isn't enough
            try:
                challenge = driver.ele("xpath://iframe[contains(@src,'bframe')]", timeout=0.3)
                if challenge:
                    return False
            except Exception:
                pass

        return is_solved(driver)
    except Exception as e:
        print(f"  [Captcha] Checkbox error: {e}", file=sys.stderr)
        return False


def solve_audio_challenge(driver) -> bool:
    """Solve via audio challenge (download MP3 → STT)."""
    try:
        import urllib.request
        import tempfile
        import pydub
        import speech_recognition

        iframe = driver.ele("xpath://iframe[contains(@title, 'recaptcha')]", timeout=3)
        if not iframe:
            return False

        audio_btn = iframe.ele("#recaptcha-audio-button", timeout=3)
        if not audio_btn:
            return False
        audio_btn.click()
        time.sleep(1)

        if iframe.ele("Try again later", timeout=0.5):
            print("  [Captcha] Bot detected — Google blocked audio", file=sys.stderr)
            return False

        audio_src = iframe.ele("#audio-source", timeout=5)
        if not audio_src:
            return False
        src_url = audio_src.attr("src")
        if not src_url:
            return False

        with tempfile.TemporaryDirectory() as tmpdir:
            mp3_path = Path(tmpdir) / "challenge.mp3"
            wav_path = Path(tmpdir) / "challenge.wav"
            urllib.request.urlretrieve(src_url, str(mp3_path))
            sound = pydub.AudioSegment.from_mp3(str(mp3_path))
            sound.export(str(wav_path), format="wav")

            recognizer = speech_recognition.Recognizer()
            with speech_recognition.AudioFile(str(wav_path)) as source:
                audio_data = recognizer.record(source)
            text = recognizer.recognize_google(audio_data, language="en-US")

        if not text:
            return False

        response_input = iframe.ele("#audio-response", timeout=3)
        if not response_input:
            return False
        response_input.input(text.lower())

        verify_btn = iframe.ele("#recaptcha-verify-button", timeout=3)
        if verify_btn:
            verify_btn.click()
            time.sleep(2)
            return is_solved(driver)

        return False
    except Exception as e:
        print(f"  [Captcha] Audio error: {e}", file=sys.stderr)
        return False


def solve_recaptcha(driver, max_attempts: int = 3) -> bool:
    """Solve reCAPTCHA on current page."""
    for attempt in range(max_attempts):
        print(f"  [Captcha] Attempt {attempt + 1}/{max_attempts}", file=sys.stderr)
        if is_solved(driver):
            return True
        if click_recaptcha_checkbox(driver):
            return True
        if solve_audio_challenge(driver):
            return True
        time.sleep(0.5)
    return False


def export_to_playwright_format(driver, session_path: str) -> None:
    """Export DrissionPage cookies to Playwright storage_state JSON."""
    cookies_raw = driver.cookies()
    pw_cookies = []
    for c in cookies_raw:
        try:
            pw_cookies.append({
                "name": c.get("name"),
                "value": c.get("value"),
                "domain": c.get("domain", ""),
                "path": c.get("path", "/"),
                "expires": c.get("expiry", c.get("expires", -1)),
                "httpOnly": bool(c.get("httpOnly", False)),
                "secure": bool(c.get("secure", False)),
                "sameSite": c.get("sameSite", "Lax").capitalize() if c.get("sameSite") else "Lax",
            })
        except Exception:
            continue

    state = {
        "cookies": pw_cookies,
        "origins": [],
    }

    Path(session_path).parent.mkdir(parents=True, exist_ok=True)
    with open(session_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
    print(f"[Login] Wrote {len(pw_cookies)} cookies to {session_path}", file=sys.stderr)


def login(email: str, password: str, profile_dir: str, session_path: str, headless: bool) -> bool:
    driver = make_browser(profile_dir, headless=headless)
    try:
        print(f"[Login] Navigating to {LOGIN_URL}", file=sys.stderr)
        driver.get(LOGIN_URL)
        time.sleep(random.uniform(2.0, 3.5))

        # Re-inject stealth JS after navigation
        try:
            driver.run_js(_stealth_js())
        except Exception:
            pass

        # Already logged in? (e.g. redirect to /id/my-account or purchase page)
        url_now = (driver.url or "").lower()
        if "/login" not in url_now:
            print("[Login] Already logged in", file=sys.stderr)
            export_to_playwright_format(driver, session_path)
            return True

        # Fill credentials
        email_field = (
            driver.ele('@name=email', timeout=10) or
            driver.ele('css:input[type="email"]', timeout=3)
        )
        password_field = driver.ele('@name=password', timeout=3)
        if not (email_field and password_field):
            print("[Login] Could not find login fields", file=sys.stderr)
            return False

        time.sleep(random.uniform(0.5, 1.0))
        email_field.input(email)
        time.sleep(random.uniform(0.3, 0.7))
        password_field.input(password)
        time.sleep(random.uniform(0.5, 1.0))

        # Solve reCAPTCHA
        if not solve_recaptcha(driver, max_attempts=3):
            print("[Login] Could not solve reCAPTCHA", file=sys.stderr)
            return False

        # Submit form
        submit_btn = (
            driver.ele('css:button[type="submit"]', timeout=3) or
            driver.ele('@type=submit', timeout=2) or
            driver.ele('xpath://button[contains(text(),"Login") or contains(text(),"Masuk")]', timeout=2)
        )
        if submit_btn:
            time.sleep(random.uniform(0.3, 0.8))
            submit_btn.click()
        else:
            # Fallback: form.submit()
            driver.run_js("document.querySelector('form').submit();")

        # Wait for redirect away from /login
        deadline = time.time() + 30
        while time.time() < deadline:
            url_now = (driver.url or "").lower()
            if "/login" not in url_now:
                break
            time.sleep(1)

        if "/login" in (driver.url or "").lower():
            print(f"[Login] Still on login page after submit: {driver.url}", file=sys.stderr)
            return False

        print(f"[Login] ✓ Logged in (URL: {driver.url})", file=sys.stderr)

        # Visit purchase page to ensure session cookies are set
        try:
            driver.get(PURCHASE_URL)
            time.sleep(2)
        except Exception:
            pass

        export_to_playwright_format(driver, session_path)
        return True
    finally:
        try:
            driver.quit()
        except Exception:
            pass


def main() -> int:
    # Load .env file if present (for LM_EMAIL/LM_PASSWORD)
    env_path = Path(__file__).resolve().parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)

    parser = argparse.ArgumentParser()
    parser.add_argument("--email", default=os.environ.get("LM_EMAIL"))
    parser.add_argument("--password", default=os.environ.get("LM_PASSWORD"))
    parser.add_argument("--profile-dir",
                        default=os.path.expanduser("~/.antam_bot_profile"))
    parser.add_argument("--session-out", default="data/session.json")
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()

    if not args.email or not args.password:
        print("Missing email/password (set LM_EMAIL/LM_PASSWORD or pass --email/--password)",
              file=sys.stderr)
        return 2

    ok = login(args.email, args.password, args.profile_dir, args.session_out, args.headless)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
