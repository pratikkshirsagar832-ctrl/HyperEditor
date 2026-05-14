/**
 * Aspect ratio conversion for video segments.
 * Replaces Clipify's MoviePy-based conversion with FFmpeg crop/scale filters.
 */
import { runFFmpeg, getMediaInfo, hasAudioStream } from '../server/ffmpeg.js';

/**
 * Convert a video to a target aspect ratio (center crop + scale).
 * @param {string} inputPath - Path to input video
 * @param {string} outputPath - Path for output video
 * @param {'9:16'|'16:9'|'1:1'} targetRatio - Desired aspect ratio
 * @param {string} [jobId] - For logging
 * @param {object} [opts] - { signal?: AbortSignal }
 * @returns {Promise<void>}
 */
export async function convertToAspectRatio(inputPath, outputPath, targetRatio, jobId = '', opts = {}) {
  if (targetRatio === 'none') {
    // Just copy as-is
    await runFFmpeg(['-y', '-i', inputPath, '-c', 'copy', outputPath], jobId, opts);
    return;
  }

  const info = await getMediaInfo(inputPath);
  const { width, height } = info;
  if (!width || !height) {
    throw new Error(`Could not determine dimensions for ${inputPath}`);
  }

  const isLandscape = width > height;

  // Calculate crop dimensions for target ratio
  let cropW, cropH;
  switch (targetRatio) {
    case '9:16': {
      if (isLandscape) {
        // Landscape → vertical: crop center to 9:16 (w:h)
        cropH = height;
        cropW = Math.round(height * 9 / 16);
      } else {
        // Portrait: already close, crop to exact 9:16
        const inputRatio = width / height;
        const target = 9 / 16;
        if (inputRatio > target) {
          // Wider than 9:16, crop width
          cropH = height;
          cropW = Math.round(height * 9 / 16);
        } else {
          // Taller than 9:16, crop height
          cropW = width;
          cropH = Math.round(width * 16 / 9);
        }
      }
      break;
    }
    case '16:9': {
      if (!isLandscape) {
        // Portrait → landscape: crop center to 16:9
        cropW = width;
        cropH = Math.round(width * 9 / 16);
      } else {
        const inputRatio = width / height;
        const target = 16 / 9;
        if (inputRatio > target) {
          cropH = height;
          cropW = Math.round(height * 16 / 9);
        } else {
          cropW = width;
          cropH = Math.round(width * 9 / 16);
        }
      }
      break;
    }
    case '1:1': {
      const size = Math.min(width, height);
      cropW = size;
      cropH = size;
      break;
    }
    default:
      throw new Error(`Unknown aspect ratio: ${targetRatio}`);
  }

  // Center crop, then scale to standard output size
  const cropX = Math.round((width - cropW) / 2);
  const cropY = Math.round((height - cropH) / 2);

  const filter = `crop=${cropW}:${cropH}:${cropX}:${cropY}`;

  await runFFmpeg([
    '-y', '-i', inputPath,
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '22',
    '-c:a', 'aac', '-b:a', '128k',
    outputPath,
  ], jobId, opts);
}

export default { convertToAspectRatio };
