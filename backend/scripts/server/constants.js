/**
 * Shared constants for HyperEdit server.
 */

/**
 * Default timeline track definitions.
 * V1 = base video, V2/V3 = overlays, A1/A2 = audio, T1 = captions.
 * Used when creating a new session or restoring from disk without saved tracks.
 */
export const DEFAULT_TRACKS = [
  { id: 'T1', type: 'text', name: 'T1', order: 0 },
  { id: 'V3', type: 'video', name: 'V3', order: 1 },
  { id: 'V2', type: 'video', name: 'V2', order: 2 },
  { id: 'V1', type: 'video', name: 'V1', order: 3 },
  { id: 'A1', type: 'audio', name: 'A1', order: 4 },
  { id: 'A2', type: 'audio', name: 'A2', order: 5 },
];
