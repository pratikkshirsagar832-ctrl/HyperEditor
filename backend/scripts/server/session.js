/**
 * Session CRUD — create, get, restore, cleanup.
 * Extracted from local-ffmpeg-server.js.
 */
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';
import fs, { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { createLogger } from './utils/logger.js';
import { DEFAULT_TRACKS } from './constants.js';

const log = createLogger('session');

const TEMP_DIR = join(tmpdir(), 'hyperedit-ffmpeg');
const SESSIONS_DIR = join(TEMP_DIR, 'sessions');
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;     // every hour

// In-memory session store
const sessions = new Map();

// Ensure temp directories exist at import time
if (!existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}
if (!existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Create a new session.
 */
export function createSession(originalName) {
  const sessionId = randomUUID();
  const sessionDir = join(SESSIONS_DIR, sessionId);
  const assetsDir = join(sessionDir, 'assets');
  const rendersDir = join(sessionDir, 'renders');

  fs.mkdirSync(sessionDir, { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(rendersDir, { recursive: true });

  const projectState = {
    tracks: [...DEFAULT_TRACKS],
    clips: [],
    settings: { width: 1920, height: 1080, fps: 30 },
  };

  const session = {
    id: sessionId,
    dir: sessionDir,
    assetsDir,
    rendersDir,
    currentVideo: join(sessionDir, 'current.mp4'),
    originalName,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_MAX_AGE_MS,
    editCount: 0,
    assets: new Map(),
    project: projectState,
    transcriptCache: new Map(),
  };
  sessions.set(sessionId, session);
  log.info(`Session created: ${sessionId}`);
  return session;
}

/**
 * Get session by ID — returns cached session or lazy-loads from disk.
 */
export async function getSession(sessionId) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  return getOrLoadSession(sessionId);
}

/**
 * Synchronous session lookup (only for already-loaded sessions).
 */
export function getCachedSession(sessionId) {
  return sessions.get(sessionId) || null;
}

/**
 * Check session health — returns whether the session is still valid.
 */
export function checkSessionHealth(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { valid: false, reason: 'Session not found', message: 'Session expired. Please refresh the page.' };
  if (Date.now() > (session.expiresAt || session.createdAt + SESSION_MAX_AGE_MS)) {
    return { valid: false, reason: 'Session expired', message: 'Session has expired. Please refresh the page.' };
  }
  const remaining = Math.round(((session.expiresAt || session.createdAt + SESSION_MAX_AGE_MS) - Date.now()) / 60000);
  return { valid: true, remainingMinutes: remaining };
}

/**
 * Lazy-load a session from disk.
 */
async function getOrLoadSession(sessionId) {
  const sessionDir = join(SESSIONS_DIR, sessionId);
  const assetsDir = join(sessionDir, 'assets');
  const rendersDir = join(sessionDir, 'renders');

  try {
    await fs.promises.access(assetsDir);
  } catch {
    return null;
  }

  // Restore project state
  const projectPath = join(sessionDir, 'project.json');
  let projectState = {
    tracks: [...DEFAULT_TRACKS],
    clips: [],
    settings: { width: 1920, height: 1080, fps: 30 },
  };
  try {
    const content = await fs.promises.readFile(projectPath, 'utf-8');
    projectState = JSON.parse(content);
  } catch { /* no saved project */ }

  // Restore assets
  const assets = new Map();
  const assetsMetaPath = join(sessionDir, 'assets-meta.json');
  let savedMeta = {};
  try {
    const metaContent = await fs.promises.readFile(assetsMetaPath, 'utf-8');
    savedMeta = JSON.parse(metaContent);
  } catch { /* no meta */ }

  try {
    const files = await fs.promises.readdir(assetsDir, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile() || file.name.includes('_thumb')) continue;
      const assetId = file.name.replace(/\.[^/.]+$/, '');
      const ext = file.name.split('.').pop().toLowerCase();
      let type = 'video';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) type = 'image';
      else if (['mp3', 'wav', 'aac', 'm4a'].includes(ext)) type = 'audio';

      try {
        const stats = await fs.promises.stat(join(assetsDir, file.name));
        if (stats.size < 1024) continue;
        const sm = savedMeta[assetId] || {};
        const thumbPath = join(assetsDir, `${assetId}_thumb.jpg`);
        let thumbExists = false;
        try { await fs.promises.access(thumbPath); thumbExists = true; } catch { /* thumbnail may not exist */ }
        assets.set(assetId, {
          id: assetId, type: sm.type || type, filename: sm.filename || file.name,
          path: join(assetsDir, file.name), thumbPath: thumbExists ? thumbPath : null,
          size: stats.size, createdAt: sm.createdAt || stats.mtimeMs,
          aiGenerated: sm.aiGenerated || false, description: sm.description,
          duration: sm.duration, width: sm.width, height: sm.height,
          editCount: sm.editCount ?? 0,
        });
      } catch { /* skip unstatable files */ }
    }
  } catch { /* no assets dir */ }

  const session = {
    id: sessionId, dir: sessionDir, assetsDir, rendersDir,
    currentVideo: join(sessionDir, 'current.mp4'),
    originalName: 'Restored Project', createdAt: Date.now(),
    editCount: 0, assets, project: projectState,
    transcriptCache: new Map(),
  };
  sessions.set(sessionId, session);
  log.info(`Session lazy-loaded: ${sessionId} (${assets.size} assets)`);
  return session;
}

/**
 * Delete a session (in-memory and on-disk).
 */
export async function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    try {
      await fs.promises.rm(session.dir, { recursive: true, force: true });
      sessions.delete(sessionId);
      log.info(`Session cleaned up: ${sessionId}`);
    } catch (e) {
      log.error(`Session cleanup error for ${sessionId}`, e);
    }
  }
}

/**
 * Remove orphaned session directories older than 24 hours.
 */
export async function cleanupOrphanedSessions() {
  try {
    let dirs;
    try {
      dirs = await fs.promises.readdir(SESSIONS_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    let cleaned = 0;
    for (const dirent of dirs) {
      if (!dirent.isDirectory()) continue;
      const dirPath = join(SESSIONS_DIR, dirent.name);
      try {
        const stat = await fs.promises.stat(dirPath);
        if (stat.mtimeMs < cutoff) {
          await fs.promises.rm(dirPath, { recursive: true, force: true });
          if (sessions.has(dirent.name)) sessions.delete(dirent.name);
          cleaned++;
        }
      } catch { /* race: already removed */ }
    }
    if (cleaned > 0) log.info(`Removed ${cleaned} orphaned session(s)`);
  } catch (e) {
    log.warn('Error cleaning orphaned sessions', e);
  }
}

// Run once at startup, then every hour
cleanupOrphanedSessions();
setInterval(cleanupOrphanedSessions, CLEANUP_INTERVAL_MS);

/**
 * Clean up old in-memory sessions (2+ hours old).
 */
setInterval(() => {
  const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
  for (const [id, session] of sessions) {
    if (session.createdAt < twoHoursAgo) {
      cleanupSession(id);
    }
  }
}, 30 * 60 * 1000);

/**
 * Restore all sessions from disk on startup.
 */
export function restoreSessionsFromDisk() {
  log.info('Restoring sessions from disk...');
  let sessionDirs;
  try {
    sessionDirs = readdirSync(SESSIONS_DIR, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  } catch {
    return;
  }

  for (const sessionId of sessionDirs) {
    const sessionDir = join(SESSIONS_DIR, sessionId);
    const assetsDir = join(sessionDir, 'assets');
    const rendersDir = join(sessionDir, 'renders');

    if (!existsSync(assetsDir)) {
      log.info(`Skipping ${sessionId} — no assets directory`);
      continue;
    }

    const projectPath = join(sessionDir, 'project.json');
    let projectState = {
      tracks: [...DEFAULT_TRACKS],
      clips: [],
      settings: { width: 1920, height: 1080, fps: 30 },
    };
    if (existsSync(projectPath)) {
      try { projectState = JSON.parse(readFileSync(projectPath, 'utf-8')); } catch (err) { console.debug('Failed to load project state:', err?.message); }
    }

    const assets = new Map();
    const assetsMetaPath = join(sessionDir, 'assets-meta.json');
    let savedAssetsMeta = {};
    if (existsSync(assetsMetaPath)) {
      try { savedAssetsMeta = JSON.parse(readFileSync(assetsMetaPath, 'utf-8')); } catch (err) { console.debug('Failed to load assets meta:', err?.message); }
    }

    const assetFiles = readdirSync(assetsDir, { withFileTypes: true })
      .filter(dirent => dirent.isFile() && !dirent.name.includes('_thumb'));

    for (const assetFile of assetFiles) {
      const assetPath = join(assetsDir, assetFile.name);
      const assetId = assetFile.name.replace(/\.[^/.]+$/, '');
      const ext = assetFile.name.split('.').pop().toLowerCase();
      let type = 'video';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) type = 'image';
      else if (['mp3', 'wav', 'aac', 'm4a'].includes(ext)) type = 'audio';
      try {
        const stats = statSync(assetPath);
        if (stats.size < 1024) continue;
        const savedMeta = savedAssetsMeta[assetId] || {};
        const thumbPath = join(assetsDir, `${assetId}_thumb.jpg`);
        assets.set(assetId, {
          id: assetId, type: savedMeta.type || type, filename: savedMeta.filename || assetFile.name,
          path: assetPath, thumbPath: existsSync(thumbPath) ? thumbPath : null,
          size: stats.size, createdAt: savedMeta.createdAt || stats.mtimeMs,
          aiGenerated: savedMeta.aiGenerated || false,
          duration: savedMeta.duration, width: savedMeta.width, height: savedMeta.height,
          editCount: savedMeta.editCount ?? 0,
        });
      } catch { /* skip */ }
    }

    if (assets.size === 0) {
      log.info(`Skipping ${sessionId} — no assets found`);
      continue;
    }

    const session = {
      id: sessionId, dir: sessionDir, assetsDir, rendersDir,
      currentVideo: join(sessionDir, 'current.mp4'),
      originalName: 'Restored Project', createdAt: Date.now(),
      editCount: 0, assets, project: projectState, transcriptCache: new Map(),
    };
    sessions.set(sessionId, session);
    log.info(`Session restored: ${sessionId} (${assets.size} assets)`);
  }
  log.info(`Restored ${sessions.size} sessions from disk`);
}
