/**
 * Minimal image codec: TGA in, PNG in/out, plus a box-filter downscale.
 *
 * WHY WRITE THIS RATHER THAN INSTALL SOMETHING
 * The LOD0 map endpoint returns a GZIP-compressed TGA, and no maintained pure-JS image
 * library reads TGA (sharp does not, jimp does not). The alternatives were a native
 * dependency that has to build on both Windows and the Actions runner, or shelling out to
 * ImageMagick and requiring it on every machine that runs the bot. Both are heavier and more
 * fragile than the ~300 lines here, and the bot is deliberately dependency-light (its only
 * runtime dependency is steam-user). Everything below uses node:zlib and nothing else.
 *
 * Scope is exactly what the pipeline needs, no more:
 *  - TGA: uncompressed and RLE true-colour (types 2 and 10), 24 or 32 bits, either origin.
 *  - PNG in: 8-bit greyscale / RGB / palette / grey+alpha / RGBA, non-interlaced. That covers
 *    the free Wonderstruck CDN maps, which is the only PNG we ever read.
 *  - PNG out: 8-bit RGB with adaptive filtering, which is what makes a 4608x4608 terrain
 *    image land in single-digit megabytes instead of tens.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** A decoded image: packed 8-bit RGB, three bytes per pixel, top-left origin. */
export interface Raster {
  width: number;
  height: number;
  /** length === width * height * 3 */
  rgb: Buffer;
}

/* ============================== TGA ============================== */

/**
 * Decode a TGA into top-left-origin RGB.
 *
 * Header (18 bytes, little-endian): idLength u8, colourMapType u8, imageType u8,
 * colourMapSpec[5], xOrigin u16, yOrigin u16, width u16, height u16, pixelDepth u8,
 * descriptor u8. Bit 5 of the descriptor is the vertical origin: 0 = bottom-left (the TGA
 * default, and what the game sends), 1 = top-left. Getting this bit wrong flips the planet
 * upside down and silently breaks every coordinate we later draw on it, so it is honoured
 * rather than assumed.
 *
 * Pixel order on disk is BGR(A), not RGB.
 */
export function decodeTga(buf: Buffer): Raster {
  if (buf.length < 18) throw new Error("TGA too short");
  const idLength = buf.readUInt8(0);
  const colourMapType = buf.readUInt8(1);
  const imageType = buf.readUInt8(2);
  const width = buf.readUInt16LE(12);
  const height = buf.readUInt16LE(14);
  const depth = buf.readUInt8(16);
  const descriptor = buf.readUInt8(17);

  if (colourMapType !== 0) throw new Error(`TGA colour-mapped images not supported (type ${colourMapType})`);
  if (imageType !== 2 && imageType !== 10) {
    throw new Error(`TGA image type ${imageType} not supported (expected 2 or 10)`);
  }
  if (depth !== 24 && depth !== 32) throw new Error(`TGA pixel depth ${depth} not supported`);
  if (width <= 0 || height <= 0) throw new Error(`TGA has no size (${width}x${height})`);

  const bytesPerPixel = depth / 8;
  const total = width * height;
  // Colour map spec is 5 bytes even when there is no colour map.
  let o = 18 + idLength + 0;
  const pixels = Buffer.allocUnsafe(total * 3);

  const writePixel = (dst: number, src: number): void => {
    // BGR on disk -> RGB in memory. The alpha byte of a 32-bit TGA is dropped: the map is
    // opaque terrain and an alpha channel would only cost storage.
    pixels[dst] = buf[src + 2];
    pixels[dst + 1] = buf[src + 1];
    pixels[dst + 2] = buf[src];
  };

  if (imageType === 2) {
    const need = total * bytesPerPixel;
    if (o + need > buf.length) throw new Error("TGA pixel data truncated");
    for (let i = 0; i < total; i++) writePixel(i * 3, o + i * bytesPerPixel);
  } else {
    // Type 10: run-length encoded. Each packet starts with a control byte whose top bit
    // marks a run (one pixel value repeated count times) versus a literal block.
    let i = 0;
    while (i < total) {
      if (o >= buf.length) throw new Error("TGA RLE data truncated");
      const control = buf.readUInt8(o++);
      const count = (control & 0x7f) + 1;
      if (i + count > total) throw new Error("TGA RLE run overruns the image");
      if (control & 0x80) {
        if (o + bytesPerPixel > buf.length) throw new Error("TGA RLE run truncated");
        for (let n = 0; n < count; n++) writePixel((i + n) * 3, o);
        o += bytesPerPixel;
        i += count;
      } else {
        if (o + count * bytesPerPixel > buf.length) throw new Error("TGA literal block truncated");
        for (let n = 0; n < count; n++) writePixel((i + n) * 3, o + n * bytesPerPixel);
        o += count * bytesPerPixel;
        i += count;
      }
    }
  }

  const topLeftOrigin = (descriptor & 0x20) !== 0;
  return topLeftOrigin
    ? { width, height, rgb: pixels }
    : { width, height, rgb: flipVertical(width, height, pixels) };
}

/** Mirror the rows. TGA stores bottom-up by default; PNG and every viewer want top-down. */
export function flipVertical(width: number, height: number, rgb: Buffer): Buffer {
  const stride = width * 3;
  const out = Buffer.allocUnsafe(rgb.length);
  for (let y = 0; y < height; y++) {
    rgb.copy(out, (height - 1 - y) * stride, y * stride, y * stride + stride);
  }
  return out;
}

/* ============================== PNG ============================== */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.allocUnsafe(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode packed RGB as an 8-bit true-colour PNG.
 *
 * Each scanline is filtered before compression. Rather than always using filter 0 (none),
 * every scanline tries all five PNG filters and keeps whichever gives the smallest sum of
 * absolute signed values, the heuristic the PNG specification itself suggests. On terrain
 * maps this is the difference between an image that fits comfortably in the storage budget
 * and one that does not: neighbouring blocks are usually near-identical colours, which the
 * Up/Paeth filters turn into long runs of zeroes for deflate to eat.
 */
export function encodePng(img: Raster): Buffer {
  const { width, height, rgb } = img;
  if (rgb.length !== width * height * 3) throw new Error("encodePng: buffer size does not match dimensions");

  const bpp = 3;
  const stride = width * bpp;
  // One extra byte per row for the filter type.
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  const candidates = [
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
    Buffer.allocUnsafe(stride),
  ];
  const zero = Buffer.alloc(stride);
  let prev = zero;

  for (let y = 0; y < height; y++) {
    const line = rgb.subarray(y * stride, y * stride + stride);
    let best = 0;
    let bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const out = candidates[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0; // left
        const b = prev[i]; // up
        const c = i >= bpp ? prev[i - bpp] : 0; // up-left
        let v: number;
        switch (f) {
          case 0: v = line[i]; break;
          case 1: v = line[i] - a; break;
          case 2: v = line[i] - b; break;
          case 3: v = line[i] - ((a + b) >> 1); break;
          default: {
            // Paeth predictor.
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            v = line[i] - pred;
          }
        }
        const byte = v & 0xff;
        out[i] = byte;
        // Sum of absolute signed values: bytes near 0 or 255 are cheap for deflate.
        score += byte < 128 ? byte : 256 - byte;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    const rowStart = y * (stride + 1);
    raw[rowStart] = best;
    candidates[best].copy(raw, rowStart + 1);
    prev = line;
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // colour type 2 = truecolour RGB
  ihdr.writeUInt8(0, 10); // compression: deflate
  ihdr.writeUInt8(0, 11); // filter method 0
  ihdr.writeUInt8(0, 12); // no interlace

  // level 9 costs seconds on a 21-megapixel image and saves megabytes of permanent storage,
  // which is the right side of that trade for something written once and served forever.
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Decode a non-interlaced 8-bit PNG into packed RGB.
 *
 * Only needed for the free CDN maps (which we re-encode and downscale rather than blindly
 * mirror), so interlacing and 16-bit depths are rejected loudly instead of half-supported.
 */
export function decodePng(buf: Buffer): Raster {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("not a PNG");
  let o = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];

  while (o + 8 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString("ascii", o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colourType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    o += 12 + len;
  }

  if (bitDepth !== 8) throw new Error(`PNG bit depth ${bitDepth} not supported`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`PNG colour type ${colourType} not supported`);
  if (colourType === 3 && !palette) throw new Error("palette PNG without a PLTE chunk");

  const bpp = channels;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error("PNG data truncated");

  // Undo the per-scanline filters in place.
  const lines = Buffer.allocUnsafe(height * stride);
  let prevStart = -1;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? lines[dst + i - bpp] : 0;
      const b = prevStart >= 0 ? lines[prevStart + i] : 0;
      const c = prevStart >= 0 && i >= bpp ? lines[prevStart + i - bpp] : 0;
      const x = raw[src + i];
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`PNG filter ${filter} is invalid`);
      }
      lines[dst + i] = v & 0xff;
    }
    prevStart = dst;
  }

  // Normalise every supported colour type to packed RGB.
  const rgb = Buffer.allocUnsafe(width * height * 3);
  const px = width * height;
  for (let i = 0; i < px; i++) {
    const s = i * bpp;
    const d = i * 3;
    if (colourType === 2 || colourType === 6) {
      rgb[d] = lines[s];
      rgb[d + 1] = lines[s + 1];
      rgb[d + 2] = lines[s + 2];
    } else if (colourType === 0 || colourType === 4) {
      rgb[d] = rgb[d + 1] = rgb[d + 2] = lines[s];
    } else {
      const p = lines[s] * 3;
      rgb[d] = palette![p];
      rgb[d + 1] = palette![p + 1];
      rgb[d + 2] = palette![p + 2];
    }
  }
  return { width, height, rgb };
}

/* ============================== Resampling ============================== */

/**
 * Box-filter downscale so the longest side is at most `maxSide`.
 *
 * A box filter (averaging every source pixel that falls in a destination cell) rather than
 * nearest-neighbour: on a 1-pixel-per-block map, dropping pixels would make thin features
 * like roads and rivers flicker in and out depending on the scale factor, while averaging
 * degrades them gracefully. Returns the input untouched when it is already small enough.
 */
export function downscale(img: Raster, maxSide: number): Raster {
  const { width, height, rgb } = img;
  const longest = Math.max(width, height);
  if (longest <= maxSide) return img;

  const scale = maxSide / longest;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = Buffer.allocUnsafe(outW * outH * 3);

  for (let y = 0; y < outH; y++) {
    const y0 = Math.floor((y * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / outH));
    for (let x = 0; x < outW; x++) {
      const x0 = Math.floor((x * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy++) {
        let s = (sy * width + x0) * 3;
        for (let sx = x0; sx < x1; sx++) {
          r += rgb[s];
          g += rgb[s + 1];
          b += rgb[s + 2];
          s += 3;
          n++;
        }
      }
      const d = (y * outW + x) * 3;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
    }
  }
  return { width: outW, height: outH, rgb: out };
}
