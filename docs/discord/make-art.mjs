// The Discord card's art, in Helm's own look, using only Node built-ins.
//   helm.png           the logo, full-bleed (Discord rounds the corners itself)
//   helm-working.gif   the same logo with the wheel slowly turning
//   working/waiting/idle.png   Helm's status dot on its raised surface
// The wheel is taken from the REAL logo (web/public/icon-512.png), not redrawn: its
// two colours (tile and amber) let each pixel be read back as "how much wheel".
//
//   node docs/discord/make-art.mjs
// writes these five files next to this script. The card loads them by LINK from
// the `discord-art-v1` tag (server/src/discord.mjs), so changed art means a new
// tag (discord-art-v2...) and a matching change to ART there. Never move an old
// tag: Discord caches each link, so new bytes behind an old link may never show.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(out, '..', '..');

// ------------------------------------------------------------- PNG in and out
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function decodePng(buf) {
  let p = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('expected 8-bit RGBA, not interlaced');
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (v + pred) & 0xff;
    }
  }
  return { w, h, px };
}

// ------------------------------------------------------------------- GIF out
// LZW as GIF wants it, after omggif's encoder (the code-size bump has to happen at
// exactly the moment the decoder will expect it).
function lzw(indices, minCodeSize = 8) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let next = eoi + 1;
  let size = minCodeSize + 1;
  let table = new Map();
  const bytes = [];
  let cur = 0;
  let shift = 0;
  const emit = (code) => {
    cur |= code << shift;
    shift += size;
    while (shift >= 8) {
      bytes.push(cur & 0xff);
      cur >>>= 8;
      shift -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      size = minCodeSize + 1;
      table = new Map();
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (shift > 0) bytes.push(cur & 0xff);
  return Buffer.from(bytes);
}
function encodeGif(w, h, palette, frames, delayCs) {
  const parts = [];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0xf7; // global colour table of 256, 8-bit colour resolution
  parts.push(Buffer.from('GIF89a', 'ascii'), lsd, palette);
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00]));
  for (const indices of frames) {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x04, delayCs & 0xff, delayCs >> 8, 0x00, 0x00]);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(w, 5);
    desc.writeUInt16LE(h, 7);
    const data = lzw(indices);
    const blocks = [];
    for (let i = 0; i < data.length; i += 255) {
      const piece = data.subarray(i, i + 255);
      blocks.push(Buffer.from([piece.length]), piece);
    }
    parts.push(gce, desc, Buffer.from([0x08]), ...blocks, Buffer.from([0x00]));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// ------------------------------------------------- the wheel, read off the logo
const logo = decodePng(fs.readFileSync(path.join(repo, 'web', 'public', 'icon-512.png')));
const at = (x, y) => {
  const i = (y * logo.w + x) * 4;
  return [logo.px[i], logo.px[i + 1], logo.px[i + 2], logo.px[i + 3]];
};
const tile = at(40, 256).slice(0, 3); // inside the tile, clear of the wheel
const amber = at(256, 256).slice(0, 3); // the hub
const span = amber.map((v, i) => v - tile[i]);
const span2 = span.reduce((s, v) => s + v * v, 0);
const coverage = new Float32Array(logo.w * logo.h);
for (let y = 0; y < logo.h; y++) {
  for (let x = 0; x < logo.w; x++) {
    const [r, g, b, a] = at(x, y);
    if (a < 250) continue; // the rounded corners: tile, no wheel
    const d = ((r - tile[0]) * span[0] + (g - tile[1]) * span[1] + (b - tile[2]) * span[2]) / span2;
    coverage[y * logo.w + x] = Math.min(1, Math.max(0, d));
  }
}
const sample = (x, y) => {
  // bilinear, pixel centres at +0.5
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const g = (xx, yy) => (xx < 0 || yy < 0 || xx >= logo.w || yy >= logo.h ? 0 : coverage[yy * logo.w + xx]);
  return (
    g(x0, y0) * (1 - tx) * (1 - ty) + g(x0 + 1, y0) * tx * (1 - ty) + g(x0, y0 + 1) * (1 - tx) * ty + g(x0 + 1, y0 + 1) * tx * ty
  );
};
// One frame of the wheel at `angle` degrees, `size` px square, as coverage 0..1.
function wheel(size, angle) {
  const s = logo.w / size;
  const rad = (-angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cov = new Float32Array(size * size);
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let sum = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const ux = (ox + (sx + 0.5) / 2) * s - 256;
          const uy = (oy + (sy + 0.5) / 2) * s - 256;
          sum += sample(ux * cos - uy * sin + 256, ux * sin + uy * cos + 256);
        }
      }
      cov[oy * size + ox] = sum / 4;
    }
  }
  return cov;
}
const mix = (c) => tile.map((v, i) => Math.round(v + span[i] * c));

fs.mkdirSync(out, { recursive: true });

// The still logo, full-bleed.
{
  const size = 512;
  const cov = wheel(size, 0);
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const [r, g, b] = mix(cov[i]);
    rgba.set([r, g, b, 255], i * 4);
  }
  fs.writeFileSync(path.join(out, 'helm.png'), encodePng(size, size, rgba));
}

// The turning logo. Eight spokes, so 45 degrees loops seamlessly: 15 frames of 3,
// 80 ms each, a full turn in about 10 s. Slow on purpose: a status, not a spinner.
{
  const size = 256;
  const palette = Buffer.alloc(256 * 3);
  for (let i = 0; i < 256; i++) palette.set(mix(i / 255), i * 3);
  const frames = [];
  for (let f = 0; f < 15; f++) {
    const cov = wheel(size, f * 3);
    frames.push(Uint8Array.from(cov, (c) => Math.round(c * 255)));
  }
  fs.writeFileSync(path.join(out, 'helm-working.gif'), encodeGif(size, size, palette, frames, 8));
}

// The status badges: Helm's status dot, with its soft glow, on the raised surface.
{
  const size = 512;
  const SS = 4;
  const raised = [0x17, 0x17, 0x1a];
  const ring = [0x30, 0x30, 0x36];
  const hexrgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const BADGES = { working: '#5eb1ef', waiting: '#e2b34c', idle: '#4cc38a' };
  for (const [name, colour] of Object.entries(BADGES)) {
    const dot = hexrgb(colour);
    const rgba = Buffer.alloc(size * size * 4);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let inside = 0;
        const acc = [0, 0, 0];
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = px + (sx + 0.5) / SS - 256;
            const y = py + (sy + 0.5) / SS - 256;
            const d = Math.hypot(x, y);
            if (d > 256) continue;
            inside++;
            let c = d > 240 ? ring : raised; // hairline edge
            if (d <= 104) c = dot; // the dot
            else if (d <= 200) {
              // the glow, fading out like Helm's dim tints
              const t = 1 - (d - 104) / 96;
              const a = 0.32 * t * t;
              c = c.map((v, i) => v + (dot[i] - v) * a);
            }
            acc[0] += c[0];
            acc[1] += c[1];
            acc[2] += c[2];
          }
        }
        const i = (py * size + px) * 4;
        if (inside === 0) continue;
        rgba[i] = Math.round(acc[0] / inside);
        rgba[i + 1] = Math.round(acc[1] / inside);
        rgba[i + 2] = Math.round(acc[2] / inside);
        rgba[i + 3] = Math.round((inside / (SS * SS)) * 255);
      }
    }
    fs.writeFileSync(path.join(out, `${name}.png`), encodePng(size, size, rgba));
  }
}

for (const f of fs.readdirSync(out).filter((n) => !n.endsWith('.mjs'))) console.log(`${f}  ${fs.statSync(path.join(out, f)).size} bytes`);
console.log(`tile rgb(${tile}) amber rgb(${amber})`);
