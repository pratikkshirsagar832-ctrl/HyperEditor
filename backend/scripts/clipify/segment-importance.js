/**
 * Intelligent segment importance analysis for video clips.
 *
 * Two strategies:
 * 1. (Primary) DeepSeek AI semantic analysis of transcript
 * 2. (Fallback) Equal time-based splitting
 */
import { generateWithDeepSeek } from '../server/ai-deepseek.js';

/**
 * Find important video segments using DeepSeek AI analysis of the transcript.
 * Falls back to time-based splitting if AI is unavailable.
 *
 * @param {string} transcript - Full transcript text
 * @param {Array<{text: string, start: number, end: number}>} [words] - Word-level timestamps
 * @param {number} videoDuration - Total video duration in seconds
 * @param {object} [options]
 * @param {number} [options.maxSegments=5] - Maximum segments to return
 * @param {number} [options.minDuration=30] - Minimum segment duration in seconds
 * @param {function} [options.onProgress] - Progress callback
 * @param {boolean} [options.deepseekAvailable=true] - Whether DeepSeek is available
 * @returns {Promise<Array<{start: number, end: number, reason: string}>>}
 */
export async function findImportantSegments(transcript, words, videoDuration, options = {}) {
  const {
    maxSegments = 5,
    minDuration = 30,
    onProgress,
    deepseekAvailable = true,
  } = options;

  onProgress?.(`Analyzing content for ${maxSegments} segments...`);

  // Strategy 1: DeepSeek AI analysis
  if (deepseekAvailable && transcript && transcript.length > 20) {
    try {
      const segments = await analyzeWithDeepSeek(transcript, videoDuration, maxSegments, minDuration);
      if (segments && segments.length > 0) {
        return segments;
      }
    } catch (err) {
      console.warn(`[clipify] DeepSeek analysis failed, falling back to time-based split: ${err.message}`);
    }
  }

  // Strategy 2: Fallback — equal time-based split
  onProgress?.('Using time-based segmentation...');
  return timeBasedSplit(videoDuration, maxSegments, minDuration);
}

/**
 * Use DeepSeek to identify important segments from transcript.
 * @param {string} transcript
 * @param {number} totalDuration
 * @param {number} maxSegments
 * @param {number} minDuration
 * @returns {Promise<Array<{start: number, end: number, reason: string}>>}
 */
async function analyzeWithDeepSeek(transcript, totalDuration, maxSegments, minDuration) {
  const systemPrompt = `You are a video content analysis AI. Given a video transcript, identify the most important/engaging segments that would make good short-form social media clips.

Return a JSON array of objects with:
- "start": start time in seconds (number)
- "end": end time in seconds (number, at least ${minDuration}s after start)
- "reason": one-sentence explanation of why this segment is important (string)

Rules:
- Return exactly 1 to ${maxSegments} segments
- Each segment must be at least ${minDuration} seconds long
- Segments should not overlap
- Prioritize segments with key information, emotional moments, statistics, or engaging content
- The total video is ${Math.round(totalDuration)} seconds long`;

  const response = await generateWithDeepSeek({
    systemInstruction: systemPrompt,
    prompt: `Transcript: ${transcript}`,
    responseMimeType: 'application/json',
    config: { temperature: 0.3, maxOutputTokens: 2000 }
  });

  // Parse the response — DeepSeek returns JSON in response.text
  const parsed = JSON.parse(response.text);

  // Handle both array and wrapper formats
  const segments = Array.isArray(parsed) ? parsed : (parsed.segments || parsed.clips || []);

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('DeepSeek returned no segments');
  }

  // Validate and sanitize segments
  return segments
    .filter(s => {
      const start = Number(s.start);
      const end = Number(s.end);
      return !isNaN(start) && !isNaN(end) && end - start >= minDuration && start >= 0 && end <= totalDuration;
    })
    .slice(0, maxSegments)
    .map(s => ({
      start: Math.round(Number(s.start) * 10) / 10,
      end: Math.round(Number(s.end) * 10) / 10,
      reason: s.reason || 'Key segment',
    }));
}

/**
 * Fallback: divide video into equal segments.
 * @param {number} totalDuration
 * @param {number} maxSegments
 * @param {number} minDuration
 * @returns {Array<{start: number, end: number, reason: string}>}
 */
function timeBasedSplit(totalDuration, maxSegments, minDuration) {
  const idealSegmentCount = Math.min(maxSegments, Math.floor(totalDuration / minDuration));
  if (idealSegmentCount <= 0) {
    return [{ start: 0, end: totalDuration, reason: 'Full video' }];
  }

  const segmentDuration = Math.max(minDuration, totalDuration / idealSegmentCount);
  const segments = [];

  for (let i = 0; i < idealSegmentCount; i++) {
    const start = Math.round(i * segmentDuration * 10) / 10;
    const end = Math.round(Math.min((i + 1) * segmentDuration, totalDuration) * 10) / 10;
    if (end - start >= minDuration / 2) {
      segments.push({ start, end, reason: `Segment ${i + 1} of ${idealSegmentCount}` });
    }
  }

  return segments;
}

export default { findImportantSegments };
