import { BrowserContext } from 'playwright';
import { fileExists, readJson, writeJson, deleteFile } from '../../app/utils/file';
import { logger } from '../../app/utils/logger';

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export async function saveSession(context: BrowserContext, sessionFile: string): Promise<void> {
  const storageState = await context.storageState();
  await writeJson(sessionFile, storageState);
  logger.info(`[Session] Session saved → ${sessionFile}`);
}

export async function loadSession(sessionFile: string): Promise<StorageState | null> {
  const exists = await fileExists(sessionFile);
  if (!exists) {
    logger.debug('[Session] No session file found, will start fresh');
    return null;
  }
  const state = await readJson<StorageState>(sessionFile);
  if (!state) {
    logger.warn('[Session] Session file is empty or invalid');
    return null;
  }
  logger.info('[Session] Session file loaded successfully');
  return state;
}

export async function deleteSession(sessionFile: string): Promise<void> {
  await deleteFile(sessionFile);
  logger.info('[Session] Session file deleted');
}
