/**
 * Caption helpers for ASS subtitle generation.
 */

// Map our CaptionStyle.position to the libass alignment integer:
//   bottom = 2 (bottom-center), center = 5 (middle-center), top = 8 (top-center)
export function captionAlignment(position) {
  if (position === 'top') return 8;
  if (position === 'center') return 5;
  return 2;
}

// Convert a CSS hex color (`#RRGGBB`) to libass's `&HAABBGGRR` byte order
// (alpha=00 = fully opaque). Falls back to white on parse failure.
export function libassColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '&H00FFFFFF';
  const rgb = m[1];
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H00${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
}
