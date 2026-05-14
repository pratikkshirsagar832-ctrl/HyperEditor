/**
 * Clipify orchestrator — converts long videos into short clips.
 *
 * Pipeline:
 * 1. Get video asset (from session or YouTube download)
 * 2. Transcribe audio
 * 3. Find important segments (DeepSeek AI or fallback)
 * 4. Extract segments via ffmpeg
 * 5. Convert to target aspect ratio (optional)
 * 6. Generate caption clips (optional)
 * 7. Save as session assets
 */
import { join } from 'path';
import fs from 'fs';
import { getOrTranscribeVideo } from '../server/ai-transcribe.js';
import { runFFmpeg, getDuration, getMediaInfo, generateThumbnail } from '../server/ffmpeg.js';
import { findImportantSegments } from './segment-importance.js';
import { convertToAspectRatio } from './aspect-ratio.js';
import { downloadYouTubeVideo, isYtDlpAvailable } from './youtube-downloader.js';
import { saveAssetMetadata } from '../server/assets.js';
import { createLogger } from '../server/utils/logger.js';

const log = createLogger('clipify');

/**
 * Generate short clips from a video asset.
 *
 * @param {object} params
 * @param {object} params.session - Session object (from getSession)
 * @param {object} [params.asset] - Video asset object (null if youtubeUrl is used)
 * @param {object} params.options
 * @param {number} [params.options.maxShorts=5] - Max number of shorts to generate
 * @param {number} [params.options.minSegmentDuration=30] - Minimum segment length
 * @param {'9:16'|'16:9'|'1:1'|'none'} [params.options.aspectRatio='9:16'] - Target ratio
 * @param {boolean} [params.options.withCaptions=true] - Generate caption clips
 * @param {string} [params.options.youtubeUrl] - YouTube URL (if downloading)
 * @param {boolean} [params.options.deepseekAvailable=true] - DeepSeek availability
 * @param {function} [params.onProgress] - Progress callback(percent: number, step: string)
 * @param {string} [params.jobId=''] - For logging
 * @param {object} [params.signal] - AbortSignal for cancellation
 * @returns {Promise<Array<{assetId: string, start: number, end: number, duration: number, reason: string}>>}
 */
export async function createShorts({ session, asset, options, onProgress, jobId = '', signal }) {
  const {
    maxShorts = 5,
    minSegmentDuration = 30,
    aspectRatio = '9:16',
    withCaptions = true,
    youtubeUrl = '',
  } = options || {};

  const opts = { signal };

  // ── Step 0: Resolve video file ──────────────────────────────────────
  onProgress?.(0, 'Preparing video source...');
  let videoPath;
  let videoFilename;
  let videoId;

  if (youtubeUrl) {
    onProgress?.(5, 'Downloading from YouTube...');
    const tempDir = join(session.dir, 'downloads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true }); // SYNC OK: infrequent
    videoPath = await downloadYouTubeVideo(youtubeUrl, tempDir, (pct) => {
      onProgress?.(5 + Math.round(pct * 0.15), 'Downloading from YouTube...');
    }, jobId);
    videoFilename = videoPath.split(/[/\\]/).pop();
    videoId = `yt-${Date.now()}`;
  } else if (asset) {
    videoPath = asset.path;
    videoFilename = asset.filename;
    videoId = asset.id;
  } else {
    throw new Error('No video asset provided and no YouTube URL specified');
  }

  try {
    await fs.promises.access(videoPath);
  } catch {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const videoDuration = await getDuration(videoPath);
  if (!videoDuration || videoDuration < 1) {
    throw new Error('Could not determine video duration');
  }

  log.info(`Processing video: ${videoFilename} (${Math.round(videoDuration)}s)`, { jobId });

  // ── Step 1: Transcribe ─────────────────────────────────────────────
  onProgress?.(25, 'Transcribing audio...');
  let transcription = { text: '', words: [] };
  try {
    transcription = await getOrTranscribeVideo(session, { id: videoId, path: videoPath, filename: videoFilename }, jobId);
  } catch (err) {
    log.warn(`Transcription failed, proceeding without: ${err.message}`, { jobId });
  }

  // ── Step 2: Find important segments ─────────────────────────────────
  onProgress?.(40, 'Analyzing content for important segments...');
  const deepseekAvailable = !!(options.deepseekAvailable ?? true);
  const segments = await findImportantSegments(
    transcription.text,
    transcription.words,
    videoDuration,
    { maxSegments: maxShorts, minDuration: minSegmentDuration, onProgress, deepseekAvailable }
  );

  if (!segments || segments.length === 0) {
    throw new Error('No segments identified for extraction');
  }

  log.info(`Identified ${segments.length} segments`, { jobId });

  // ── Step 3: Extract each segment ────────────────────────────────────
  const createdAssets = [];
  const outputDir = join(session.dir, 'renders');
  await fs.promises.mkdir(outputDir, { recursive: true }).catch(() => {});

  const totalSegments = segments.length;
  for (let i = 0; i < totalSegments; i++) {
    const seg = segments[i];
    const segPct = 45 + Math.round((i / totalSegments) * 45);
    onProgress?.(segPct, `Extracting segment ${i + 1}/${totalSegments}: ${seg.reason}`);

    const baseName = `clipify_${jobId}_seg${i + 1}`;
    const rawPath = join(outputDir, `${baseName}_raw.mp4`);
    const finalPath = join(outputDir, `${baseName}.mp4`);

    // Extract segment with minimal re-encode for speed
    const duration = seg.end - seg.start;
    await runFFmpeg([
      '-y', '-ss', String(seg.start), '-i', videoPath,
      '-t', String(duration),
      '-c', 'copy',
      rawPath,
    ], jobId, opts);

    // Apply aspect ratio conversion if needed
    if (aspectRatio && aspectRatio !== 'none') {
      onProgress?.(segPct + 2, `Converting aspect ratio (${aspectRatio})...`);
      await convertToAspectRatio(rawPath, finalPath, aspectRatio, jobId, opts);
      try { await fs.promises.unlink(rawPath); } catch { /* raw cleanup */ }
    } else {
      // Rename raw to final
      try { await fs.promises.unlink(finalPath); } catch { /* cleanup */ }
      try { await fs.promises.rename(rawPath, finalPath); } catch { /* rename cleanup */ }
    }

    // Register as session asset
    const segFilename = `${baseName}.mp4`;
    const segId = videoId ? `${videoId}_seg${i + 1}` : `clipify_${Date.now()}_${i + 1}`;

    const stat = await fs.promises.stat(finalPath).catch(() => ({ size: 0 }));
    const mediaInfo = await getMediaInfo(finalPath);
    const thumbPath = join(session.assetsDir, `${segId}_thumb.jpg`);
    try {
      await generateThumbnail(finalPath, thumbPath, false);
    } catch (error) {
      log.warn(`Thumbnail generation failed for short ${segId}: ${error instanceof Error ? error.message : String(error)}`, { jobId });
    }
    const segAsset = {
      id: segId,
      type: 'video',
      filename: segFilename,
      path: finalPath,
      size: stat.size,
      duration: duration,
      width: mediaInfo.width,
      height: mediaInfo.height,
      aiGenerated: true,
      description: `Clipify short: ${seg.reason}`,
      createdAt: Date.now(),
      thumbPath: fs.existsSync(thumbPath) ? thumbPath : null,
    };

    session.assets.set(segId, segAsset);
    await saveAssetMetadata(session);

    createdAssets.push({
      ...segAsset,
      start: seg.start,
      end: seg.end,
      reason: seg.reason,
    });

    log.info(`Created short ${i + 1}: ${seg.start}-${seg.end}s (${seg.reason})`, { jobId });
  }

  // ── Step 4: Generate caption clips (placeholder - can be expanded) ──
  // Captions are handled client-side via the existing addCaptionClipsBatch flow.
  // Future enhancement: could pre-generate caption clips here.

  onProgress?.(100, 'Done!');
  return createdAssets;
}

export default { createShorts };
