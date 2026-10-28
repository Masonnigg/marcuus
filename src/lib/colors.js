export function normalizeHex(input) {
  let s = String(input).trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (/^[0-9a-f]{8}$/.test(s)) s = s.slice(0, 6);
  return /^[0-9a-f]{6}$/.test(s) ? `#${s}` : null;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

export function formatColor(hex, format) {
  if (format === 'rgb') return `rgb(${hexToRgb(hex).join(', ')})`;
  if (format === 'hsl') {
    const [h, s, l] = rgbToHsl(hexToRgb(hex));
    return `hsl(${h}, ${s}%, ${l}%)`;
  }
  if (format === 'hexplain') return hex.slice(1).toUpperCase();
  return hex.toUpperCase();
}

// Relative luminance → pick readable text on a swatch
export function isLight(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4;
}

/** Pull every hex / rgb() color out of pasted text (CSS, lists, coolors URLs…). */
export function parseColorList(text) {
  const out = [];
  const coolors = text.match(/coolors\.co\/(?:palette\/)?([0-9a-f]{6}(?:-[0-9a-f]{6})+)/i);
  if (coolors) coolors[1].split('-').forEach((h) => out.push('#' + h.toLowerCase()));
  for (const m of text.matchAll(/#?\b([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const h = normalizeHex(m[1]);
    if (h && (m[0].startsWith('#') || m[1].length === 6)) out.push(h);
  }
  for (const m of text.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) {
    out.push(rgbToHex([+m[1], +m[2], +m[3]]));
  }
  return [...new Set(out)];
}

/** k-means palette extraction from an image File. */
export async function extractPalette(file, k = 6) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const size = 120;
    const scale = Math.min(1, size / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const px = [];
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) px.push([data[i], data[i + 1], data[i + 2]]);
    if (!px.length) return [];

    // k-means++ init
    const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const centers = [px[Math.floor(px.length / 2)]];
    while (centers.length < k) {
      const d = px.map((p) => Math.min(...centers.map((c) => dist(p, c))));
      const sum = d.reduce((a, b) => a + b, 0);
      if (!sum) break;
      let r = Math.random() * sum;
      let idx = 0;
      while ((r -= d[idx]) > 0 && idx < px.length - 1) idx++;
      centers.push(px[idx]);
    }
    let counts = [];
    for (let iter = 0; iter < 12; iter++) {
      const sums = centers.map(() => [0, 0, 0]);
      counts = centers.map(() => 0);
      for (const p of px) {
        let best = 0;
        let bd = Infinity;
        centers.forEach((c, ci) => { const dd = dist(p, c); if (dd < bd) { bd = dd; best = ci; } });
        sums[best][0] += p[0]; sums[best][1] += p[1]; sums[best][2] += p[2];
        counts[best]++;
      }
      centers.forEach((c, ci) => { if (counts[ci]) centers[ci] = sums[ci].map((v) => v / counts[ci]); });
    }
    return centers
      .map((c, i) => ({ hex: rgbToHex(c), n: counts[i] }))
      .filter((c) => c.n > 0)
      .sort((a, b) => b.n - a.n)
      .map((c) => c.hex)
      .filter((h, i, a) => a.indexOf(h) === i);
  } finally {
    URL.revokeObjectURL(url);
  }
}
