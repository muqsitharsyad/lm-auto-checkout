import dotenv from "dotenv";

dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export interface AppConfig {
  lmEmail: string;
  lmPassword: string;
  telegramBotToken: string;
  telegramChatId: string;
  /** Public URL of /auth endpoint (sent in Telegram alerts as login link). */
  authUrl: string;
  /** Target gramasi to checkout (e.g., [0.5, 1, 2, 3]). Empty = all available */
  targetWeights: number[];
  /** Webhook port for receiving checkout triggers from stock-scheduler */
  webhookPort: number;
  headless: boolean;
  /** Session refresh interval in seconds */
  sessionRefreshInterval: number;
  /** Cooldown after successful checkout in seconds (prevents duplicate orders) */
  checkoutCooldownSeconds: number;
  logLevel: string;
  debugScreenshotOnError: boolean;
  witAiToken: string | undefined;
  dataDir: string;
  sessionFile: string;
  debugDir: string;
}

export function loadConfig(): AppConfig {
  const lmEmail = requireEnv("LM_EMAIL");
  const lmPassword = requireEnv("LM_PASSWORD");
  const telegramBotToken = requireEnv("TELEGRAM_BOT_TOKEN");
  const telegramChatId = requireEnv("TELEGRAM_CHAT_ID");
  const authUrl = optionalEnv("AUTH_URL", "");

  const targetWeightsRaw = optionalEnv("TARGET_WEIGHTS", "0.5,1,2,3");
  const targetWeights = targetWeightsRaw
    .split(",")
    .map((w) => parseFloat(w.trim().replace(",", ".")))
    .filter((w) => !isNaN(w) && w > 0);

  const webhookPort = parseInt(optionalEnv("WEBHOOK_PORT", "3300"), 10);
  const headless = optionalEnv("HEADLESS", "false").toLowerCase() === "true";
  const sessionRefreshInterval = parseInt(
    optionalEnv("SESSION_REFRESH_INTERVAL", "300"),
    10,
  );
  const checkoutCooldownSeconds = parseInt(
    optionalEnv("CHECKOUT_COOLDOWN_SECONDS", "3600"),
    10,
  );
  const logLevel = optionalEnv("LOG_LEVEL", "info");
  const debugScreenshotOnError =
    optionalEnv("DEBUG_SCREENSHOT_ON_ERROR", "true").toLowerCase() !== "false";
  const witAiToken = process.env["WIT_AI_ACCESS_TOKEN"] || undefined;

  const dataDir = "data";

  return {
    lmEmail,
    lmPassword,
    telegramBotToken,
    telegramChatId,
    authUrl,
    targetWeights,
    webhookPort,
    headless,
    sessionRefreshInterval,
    checkoutCooldownSeconds,
    logLevel,
    debugScreenshotOnError,
    witAiToken,
    dataDir,
    sessionFile: `${dataDir}/session.json`,
    debugDir: `${dataDir}/debug`,
  };
}

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) {
    _config = loadConfig();
  }
  return _config;
}
