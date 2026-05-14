/**
 * All Zod validation schemas for HyperEdit API endpoints.
 */
import z from 'zod';

// ── Clip schema ────────────────────────────────────────────────────────────
export const ClipSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  trackId: z.string(),
  start: z.number(),
  duration: z.number(),
  inPoint: z.number(),
  outPoint: z.number(),
  muted: z.boolean().optional(),
  volume: z.number().optional(),
  transform: z.object({
    x: z.number().optional(),
    y: z.number().optional(),
    scale: z.number().optional(),
    rotation: z.number().optional(),
    opacity: z.number().optional(),
    cropTop: z.number().optional(),
    cropBottom: z.number().optional(),
    cropLeft: z.number().optional(),
    cropRight: z.number().optional(),
  }).optional(),
});

export const TrackSchema = z.object({
  id: z.string(),
  type: z.enum(['video', 'audio', 'text']),
  name: z.string(),
  order: z.number(),
});

export const ProjectSchema = z.object({
  tracks: z.array(TrackSchema).optional(),
  clips: z.array(ClipSchema).optional(),
  settings: z.object({
    width: z.number().optional(),
    height: z.number().optional(),
    fps: z.number().optional(),
  }).optional(),
  captions: z.record(z.any()).optional(),
  timelineTabs: z.array(z.any()).optional(),
  version: z.number().optional(),
});

// ── Auto Shorts (Clipify) ─────────────────────────────────────────────────
export const AutoShortsSchema = z.object({
  assetId: z.string().optional(),
  maxShorts: z.number().int().min(1).max(20).default(5),
  minSegmentDuration: z.number().min(5).max(300).default(30),
  aspectRatio: z.enum(['9:16', '1:1', '16:9', 'none']).default('9:16'),
  withCaptions: z.boolean().default(true),
  withBroll: z.boolean().default(false),
  youtubeUrl: z.string().url().optional(),
});

// ── Transcribe ─────────────────────────────────────────────────────────────
export const TranscribeSchema = z.object({
  assetId: z.string().optional(),
  language: z.string().default('en'),
});

// ── Render options ─────────────────────────────────────────────────────────
export const RenderOptionsSchema = z.object({
  preview: z.boolean().default(false),
  captions: z.record(z.any()).optional(),
});

// ── Dead air removal ───────────────────────────────────────────────────────
export const DeadAirSchema = z.object({
  silenceThreshold: z.number().default(-30),
  minSilenceDuration: z.number().default(0.3),
});

// ── Generate animation ─────────────────────────────────────────────────────
export const GenerateAnimationSchema = z.object({
  prompt: z.string().min(1),
  useExistingAsset: z.boolean().optional(),
  assetId: z.string().optional(),
  captionText: z.string().optional(),
  duration: z.number().positive().optional(),
});

// ── Generate batch animations ──────────────────────────────────────────────
export const GenerateBatchAnimationsSchema = z.object({
  prompt: z.string().min(1),
  count: z.number().int().min(1).max(20).default(5),
});

// ── Generate B-roll ────────────────────────────────────────────────────────
export const GenerateBrollSchema = z.object({
  prompt: z.string().min(1),
  count: z.number().int().min(1).max(10).default(4),
});

// ── Transcribe and extract keywords ────────────────────────────────────────
export const TranscribeExtractSchema = z.object({
  assetId: z.string().optional(),
});

// ── Generate image (Picasso) ────────────────────────────────────────────────
export const GenerateImageSchema = z.object({
  prompt: z.string().min(1),
});

// ── Generate video (DiCaprio) ──────────────────────────────────────────────
export const GenerateVideoSchema = z.object({
  prompt: z.string().min(1),
  assetId: z.string().optional(),
});

// ── Restyle video ──────────────────────────────────────────────────────────
export const RestyleVideoSchema = z.object({
  prompt: z.string().min(1),
  assetId: z.string().optional(),
});

// ── Remove video background ────────────────────────────────────────────────
export const RemoveVideoBgSchema = z.object({
  assetId: z.string().optional(),
});

// ── Extract audio ──────────────────────────────────────────────────────────
export const ExtractAudioSchema = z.object({
  assetId: z.string().optional(),
});

// ── Process asset with FFmpeg command ──────────────────────────────────────
export const ProcessAssetSchema = z.object({
  assetId: z.string().min(1),
  command: z.string().min(1),
});

// ── Edit animation ─────────────────────────────────────────────────────────
export const EditAnimationSchema = z.object({
  assetId: z.string().min(1),
  prompt: z.string().min(1),
  tabId: z.string().optional(),
});

// ── Render from concept ────────────────────────────────────────────────────
export const RenderFromConceptSchema = z.object({
  concept: z.string().min(1),
  sceneData: z.any().optional(),
  totalDuration: z.number().positive().optional(),
});

// ── Create GIF ─────────────────────────────────────────────────────────────
export const CreateGifSchema = z.object({
  assetIds: z.array(z.string()).min(1).max(10),
  fps: z.number().positive().default(10),
  width: z.number().positive().default(400),
});
