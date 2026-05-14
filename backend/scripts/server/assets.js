/**
 * Asset management — upload, stream, thumbnail, waveform, delete.
 * Extracted from local-ffmpeg-server.js.
 */
import { randomUUID } from 'crypto';
import { join } from 'path';
import fs, { existsSync } from 'fs';
import { rename, stat } from 'fs/promises';
import formidable from 'formidable';
import { getSession } from './session.js';
import { generateThumbnail, getMediaInfo, getDuration } from './ffmpeg.js';
import { sendJSON, sendError, sendSuccess } from './middleware.js';
import { createLogger } from './utils/logger.js';

const log = createLogger('assets');

/**
 * Save asset metadata to disk.
 */
export async function saveAssetMetadata(session) {
  if (!session || !session.dir) return;
  const assetsMetaPath = join(session.dir, 'assets-meta.json');
  const metadata = {};
  for (const [assetId, asset] of session.assets) {
    metadata[assetId] = {
      type: asset.type, filename: asset.filename, createdAt: asset.createdAt,
      duration: asset.duration, width: asset.width, height: asset.height,
      aiGenerated: asset.aiGenerated || false, description: asset.description,
      sceneCount: asset.sceneCount, sceneDataPath: asset.sceneDataPath,
      editCount: asset.editCount ?? 0,
    };
  }
  try {
    await fs.promises.writeFile(assetsMetaPath, JSON.stringify(metadata, null, 2));
  } catch (e) {
    log.warn('Could not save asset metadata', e);
  }
}

/**
 * Upload asset to session.
 */
export async function handleAssetUpload(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  try {
    const form = formidable({
      maxFileSize: 10 * 1024 * 1024 * 1024,
      uploadDir: session.assetsDir,
      keepExtensions: true,
    });

    const [fields, files] = await form.parse(req);
    const uploadedFile = files.file?.[0] || files.video?.[0];
    if (!uploadedFile) { sendError(res, 400, 'Missing file'); return; }

    const assetId = randomUUID();
    const originalName = uploadedFile.originalFilename || 'file';
    const ext = originalName.split('.').pop()?.toLowerCase() || 'mp4';
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    const isAudio = ['mp3', 'wav', 'aac', 'm4a', 'ogg'].includes(ext);
    const type = isImage ? 'image' : isAudio ? 'audio' : 'video';

    const assetPath = join(session.assetsDir, `${assetId}.${ext}`);
    const thumbPath = join(session.assetsDir, `${assetId}_thumb.jpg`);

    await rename(uploadedFile.filepath, assetPath);

    let duration = 0, width = 0, height = 0;
    if (!isAudio) {
      const info = await getMediaInfo(assetPath);
      duration = info.duration;
      width = info.width;
      height = info.height;
    } else {
      duration = await getDuration(assetPath);
    }

    if (!isAudio) {
      try { await generateThumbnail(assetPath, thumbPath, isImage); } catch (e) { log.warn('Thumbnail generation failed', e); }
    }

    const stats = await stat(assetPath);
    const asset = {
      id: assetId, type, filename: originalName, path: assetPath,
      thumbPath: existsSync(thumbPath) ? thumbPath : null,
      duration: isImage ? 5 : duration, size: stats.size, width, height,
      createdAt: Date.now(),
    };
    session.assets.set(assetId, asset);
    await saveAssetMetadata(session);

    sendSuccess(res, {
      asset: {
        id: asset.id, type: asset.type, filename: asset.filename,
        duration: asset.duration, size: asset.size, width: asset.width, height: asset.height,
        thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${assetId}/thumbnail` : null,
      },
    });
  } catch (error) {
    log.error('Asset upload error', error);
    sendError(res, 500, error.message);
  }
}

/**
 * List all assets in session.
 */
export async function handleAssetList(req, res, sessionId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }

  const assets = Array.from(session.assets.values()).map(asset => ({
    id: asset.id, type: asset.type, filename: asset.filename,
    duration: asset.duration, size: asset.size, width: asset.width, height: asset.height,
    thumbnailUrl: asset.thumbPath ? `/session/${sessionId}/assets/${asset.id}/thumbnail` : null,
    aiGenerated: asset.aiGenerated || false,
  }));
  sendSuccess(res, { assets });
}

/**
 * Delete asset.
 */
export async function handleAssetDelete(req, res, sessionId, assetId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }
  const asset = session.assets.get(assetId);
  if (!asset) { sendError(res, 404, 'Asset not found'); return; }

  try {
    await fs.promises.unlink(asset.path).catch(() => {});
    if (asset.thumbPath) await fs.promises.unlink(asset.thumbPath).catch(() => {});
  } catch { /* asset already unlinked */ }

  session.assets.delete(assetId);
  await saveAssetMetadata(session);
  session.project.clips = session.project.clips.filter(clip => clip.assetId !== assetId);
  sendSuccess(res, { success: true });
}

/**
 * Get asset thumbnail.
 */
export async function handleAssetThumbnail(req, res, sessionId, assetId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }
  const asset = session.assets.get(assetId);
  if (!asset || !asset.thumbPath || !existsSync(asset.thumbPath)) {
    sendError(res, 404, 'Thumbnail not found');
    return;
  }

    const thumbStats = await stat(asset.thumbPath);
  res.writeHead(200, {
    'Content-Type': 'image/jpeg', 'Content-Length': thumbStats.size,
    'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(asset.thumbPath).pipe(res);
}

/**
 * Get waveform data for audio/video asset.
 */
export async function handleAssetWaveform(req, res, sessionId, assetId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }
  const asset = session.assets.get(assetId);
  if (!asset || !existsSync(asset.path)) { sendError(res, 404, 'Asset not found'); return; }

  try {
    const hasAudio = (await import('child_process')).spawnSync('ffprobe', [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', asset.path,
    ]);
    if (!hasAudio.stdout || hasAudio.stdout.toString().trim() !== 'audio') {
      sendJSON(res, 200, { peaks: [] });
      return;
    }

    const numSamples = 200;
    const result = (await import('child_process')).spawnSync('ffmpeg', [
      '-i', asset.path,
      '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
      '-f', 'null', '-', '-v', 'quiet',
    ], { timeout: 15000 });

    const stderr = result.stderr ? result.stderr.toString() : '';
    const rmsValues = [];
    const regex = /lavfi\.astats\.Overall\.RMS_level=(-?\d+\.?\d*)/g;
    let match;
    while ((match = regex.exec(stderr)) !== null) {
      const val = parseFloat(match[1]);
      const normalized = Math.min(1, Math.max(0, (val + 60) / 60));
      rmsValues.push(normalized);
    }

    let peaks;
    if (rmsValues.length > 10) {
      const step = Math.max(1, Math.floor(rmsValues.length / numSamples));
      peaks = [];
      for (let i = 0; i < numSamples; i++) {
        const idx = Math.min(Math.floor(i * step), rmsValues.length - 1);
        peaks.push(rmsValues[idx] ?? 0);
      }
    } else {
      const rawResult = (await import('child_process')).spawnSync('ffmpeg', [
        '-i', asset.path, '-ac', '1', '-ar', '8000', '-f', 's16le', '-', '-v', 'quiet',
      ], { timeout: 15000 });
      if (rawResult.stdout && rawResult.stdout.length > 0) {
        const samples = new Int16Array(rawResult.stdout.buffer, rawResult.stdout.byteOffset, rawResult.stdout.length / 2);
        const chunkSize = Math.max(1, Math.floor(samples.length / numSamples));
        peaks = [];
        for (let i = 0; i < numSamples; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, samples.length);
          let max = 0;
          for (let j = start; j < end; j++) { const abs = Math.abs(samples[j]); if (abs > max) max = abs; }
          peaks.push(max / 32768);
        }
      } else { peaks = []; }
    }
    sendJSON(res, 200, { peaks });
  } catch (err) {
    log.warn('Waveform error', err);
    sendJSON(res, 200, { peaks: [] });
  }
}

/**
 * Stream asset file (supports range requests for seeking).
 */
export async function handleAssetStream(req, res, sessionId, assetId) {
  const session = await getSession(sessionId);
  if (!session) { sendError(res, 404, 'Session not found'); return; }
  const asset = session.assets.get(assetId);
  if (!asset || !existsSync(asset.path)) { sendError(res, 404, 'Asset not found'); return; }

  const assetStats = await stat(asset.path);
  const fileSize = assetStats.size;

  const getContentType = () => {
    if (asset.type === 'image') {
      const mimeTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      return mimeTypes[asset.path.split('.').pop()?.toLowerCase()] || 'image/jpeg';
    }
    if (asset.type === 'audio') {
      const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' };
      return mimeTypes[asset.path.split('.').pop()?.toLowerCase()] || 'audio/mpeg';
    }
    return 'video/mp4';
  };

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    let start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}`, 'Access-Control-Allow-Origin': '*' });
      res.end(); return;
    }
    if (end >= fileSize) end = fileSize - 1;
    if (start > end) start = end;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize, 'Content-Type': getContentType(), 'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(asset.path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize, 'Content-Type': getContentType(), 'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(asset.path).pipe(res);
  }
}
