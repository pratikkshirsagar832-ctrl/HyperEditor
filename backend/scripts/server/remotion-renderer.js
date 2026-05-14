/**
 * Programmatic Remotion rendering with bundle caching and npx fallback.
 *
 * Uses @remotion/bundler to bundle once (cached for server lifetime),
 * then @remotion/renderer's renderMedia for fast, streamable renders.
 * Falls back to `npx remotion render` if programmatic rendering fails.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..'); // scripts/server/ → backend/
const FRONTEND_ROOT = path.resolve(PROJECT_ROOT, '..', 'frontend'); // backend/../frontend/
const REMOTION_ENTRY = path.resolve(FRONTEND_ROOT, 'src/remotion/index.tsx');

let cachedBundleLocation = null;
let bundlePromise = null;

/**
 * Get (or create) the cached Remotion bundle location.
 * The bundle is created once and reused for all renders.
 */
async function getBundleLocation() {
  if (cachedBundleLocation) return cachedBundleLocation;
  if (bundlePromise) return bundlePromise;

  bundlePromise = (async () => {
    console.log('[Remotion] Bundling project (one-time)...');
    const location = await bundle({
      entryPoint: REMOTION_ENTRY,
      webpackOverride: (config) => config,
    });
    cachedBundleLocation = location;
    console.log(`[Remotion] Bundle created at ${location}`);
    return location;
  })();

  try {
    return await bundlePromise;
  } catch (err) {
    console.error('[Remotion] Bundle failed, will use npx fallback:', err.message);
    bundlePromise = null;
    return null;
  }
}

/**
 * Render a Remotion composition to video using the programmatic API.
 *
 * @param {object} opts
 * @param {string} opts.compositionId - e.g. 'DynamicAnimation'
 * @param {object} opts.props - input props for the composition
 * @param {string} opts.outputPath - where to write the rendered video
 * @param {number} opts.fps - frames per second
 * @param {number} opts.width - output width
 * @param {number} opts.height - output height
 * @param {(percent: number, step?: string) => void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal] - optional abort signal
 * @returns {Promise<void>}
 */
export async function renderWithRemotion({
  compositionId = 'DynamicAnimation',
  props,
  outputPath,
  fps = 30,
  width = 1920,
  height = 1080,
  onProgress,
  signal,
}) {
  // Try programmatic API first
  const bundleLocation = await getBundleLocation();
  if (bundleLocation) {
    try {
      return await programmaticRender({
        bundleLocation,
        compositionId,
        props,
        outputPath,
        fps,
        width,
        height,
        onProgress,
        signal,
      });
    } catch (err) {
      console.warn(`[Remotion] Programmatic render failed, falling back to npx: ${err.message}`);
      // Fall through to npx fallback
    }
  }

  // Fallback: npx remotion render
  return npxRenderFallback({
    compositionId,
    props,
    outputPath,
    fps,
    width,
    height,
    onProgress,
    signal,
  });
}

async function programmaticRender({
  bundleLocation,
  compositionId,
  props,
  outputPath,
  fps,
  width,
  height,
  onProgress,
  signal,
}) {
  // Select the composition to get its duration
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: compositionId,
    inputProps: props,
  });

  // Clamp duration — must be >= 1 frame to avoid divide-by-zero in Remotion
  composition.durationInFrames = Math.max(1, composition.durationInFrames || 1);

  // Ensure the output directory exists
  const { mkdirSync } = await import('fs');
  const { dirname } = await import('path');
  mkdirSync(path.dirname(outputPath), { recursive: true });

  // Render
  await renderMedia({
    composition,
    serveUrl: bundleLocation,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: props,
    onProgress: ({ progress }) => {
      if (onProgress) onProgress(Math.round(progress * 100), 'rendering');
    },
    signal,
    overwrite: true,
  });

  console.log(`[Remotion] Render complete: ${outputPath}`);
}

async function npxRenderFallback({
  compositionId,
  props,
  outputPath,
  fps,
  width,
  height,
  onProgress,
  signal,
}) {
  // Write props to temp file
  const { randomUUID } = await import('crypto');
  const { tmpdir } = await import('os');
  const tmpDir = tmpdir();
  const jobId = randomUUID();
  const propsPath = path.join(tmpDir, `remotion-props-${jobId}.json`);
  await fs.promises.writeFile(propsPath, JSON.stringify(props, null, 2));

  // Compute total duration from props
  const totalDuration = Math.max(1, (props.totalDuration ||
    (props.scenes || []).reduce((s, sc) => s + (sc.duration || 30), 0) ||
    120));

  const entryPoint = REMOTION_ENTRY;

  const args = [
    'remotion', 'render',
    entryPoint,
    compositionId,
    outputPath,
    '--props', propsPath,
    '--frames', `0-${totalDuration - 1}`,
    '--fps', String(fps),
    '--width', String(width),
    '--height', String(height),
    '--codec', 'h264',
    '--overwrite',
  ];

  console.log(`[Remotion] npx fallback: npx ${args.slice(0, 6).join(' ')} ...`);

  await new Promise((resolve, reject) => {
    const proc = spawn('npx', args, {
      cwd: FRONTEND_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    proc.stdout.on('data', (d) => {
      const text = d.toString();
      // Parse Remotion progress lines: "Frame 42 / 120"
      const match = text.match(/Frame\s+(\d+)/);
      if (match && onProgress) {
        const frame = parseInt(match[1], 10);
        const pct = Math.round((frame / totalDuration) * 100);
        onProgress(Math.min(pct, 99), 'rendering');
      }
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    if (signal) {
      signal.addEventListener('abort', () => {
        proc.kill('SIGTERM');
        reject(Object.assign(new Error('Render cancelled'), { code: 'CANCELLED' }));
      }, { once: true });
    }

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error('Remotion npx render timed out after 10 minutes'));
    }, 600000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error('Remotion npx failed (code ' + code + '): ' + stderr.slice(-200)));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Cleanup
  try { await fs.promises.unlink(propsPath); } catch { /* props cleanup */ }
  console.log(`[Remotion] npx fallback render complete: ${outputPath}`);
}


