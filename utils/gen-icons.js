const fs = require('fs');
const zlib = require('zlib');

/* ============ PNG encode ============ */

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* ============ JPEG decode (baseline) ============ */

const ZIGZAG = [
   0,  1,  8, 16,  9,  2,  3, 10,
  17, 24, 32, 25, 18, 11,  4,  5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13,  6,  7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
];

function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

function BitReader(data, start) {
  this.data = data;
  this.pos = start;
  this.bits = 0;
  this.cnt = 0;
}
BitReader.prototype.fill = function (n) {
  while (this.cnt < n) {
    if (this.pos >= this.data.length) throw new Error('unexpected EOF in scan');
    let b = this.data[this.pos++];
    if (b === 0xff) {
      const b2 = this.data[this.pos];
      if (b2 === 0x00) {
        this.pos++; // byte stuffing: 0xFF 0x00 => data 0xFF
      } else if (b2 >= 0xd0 && b2 <= 0xd7) {
        this.pos++; // restart marker, skip
      } else {
        throw new Error('unexpected marker in scan at ' + this.pos);
      }
    }
    this.bits |= b << this.cnt;
    this.cnt += 8;
  }
};
BitReader.prototype.read = function (n) {
  if (n === 0) return 0;
  this.fill(n);
  const v = this.bits & ((1 << n) - 1);
  this.bits >>>= n;
  this.cnt -= n;
  this.bits &= (1 << this.cnt) - 1;
  return v;
};
BitReader.prototype.sync = function () { this.bits = 0; this.cnt = 0; };

function decodeSymbol(br, t) {
  if (!t) throw new Error('missing huffman table');
  let code = 0;
  for (let len = 1; len <= t.maxLen; len++) {
    code = (code << 1) | br.read(1);
    const key = (len << 16) | code;
    if (t.table[key] !== undefined) return t.table[key];
  }
  if (process.env.DEBUG_JPEG) {
    const keys = Object.keys(t.table).map(Number);
    console.error('huff fail: maxLen', t.maxLen, 'table keys sample', keys.slice(0, 8));
    console.error('bits stream around failure: br.pos', br.pos, 'byte', br.data[br.pos]);
  }
  throw new Error('bad huffman code');
}

function extendValue(v, size) {
  const half = 1 << (size - 1);
  return v < half ? v - ((1 << size) - 1) : v;
}

function idct(block) {
  const out = new Float64Array(64);
  const SQ2 = 1 / Math.SQRT2;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        const cv = v === 0 ? SQ2 : 1;
        const cy = Math.cos(((2 * y + 1) * v * Math.PI) / 16);
        for (let u = 0; u < 8; u++) {
          const cu = u === 0 ? SQ2 : 1;
          const a = block[v * 8 + u];
          if (a === 0) continue;
          sum += cu * cv * a * cy * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
        }
      }
      out[y * 8 + x] = sum / 4;
    }
  }
  return out;
}

function decodeJPEG(buf) {
  let pos = 2;
  let width = 0, height = 0;
  const comps = [];
  const qtables = [];
  const huff = { dc: [], ac: [] };
  let restartInterval = 0;

  const readU16 = () => (buf[pos++] << 8) | buf[pos++];

  function buildHuffTable(bits, vals) {
    const table = {};
    let code = 0, k = 0, maxLen = 0, minLen = 17;
    for (let i = 0; i < 16; i++) {
      const n = bits[i];
      if (n > 0) { if (i + 1 > maxLen) maxLen = i + 1; if (i + 1 < minLen) minLen = i + 1; }
      for (let j = 0; j < n; j++) { table[(i + 1) << 16 | code] = vals[k++]; code++; }
      code <<= 1;
    }
    return { table, maxLen, minLen };
  }

  function decodeBlock(br, dcTable, acTable, qtable, ctx) {
    const block = new Float64Array(64);
    const dcCat = decodeSymbol(br, dcTable);
    const dcDiff = dcCat === 0 ? 0 : extendValue(br.read(dcCat), dcCat);
    ctx.dc += dcDiff;
    block[0] = ctx.dc * qtable[0];
    let k = 1;
    while (k < 64) {
      const sym = decodeSymbol(br, acTable);
      const run = sym >> 4;
      const size = sym & 15;
      if (sym === 0) { k = 64; break; }
      k += run;
      if (k >= 64) break;
      const val = size === 0 ? 0 : extendValue(br.read(size), size);
      block[ZIGZAG[k]] = val * qtable[ZIGZAG[k]];
      k++;
    }
    return block;
  }

  function decodeScan(scanComps, startPos) {
    const mcuWidth = comps[0].h * 8;
    const mcuHeight = comps[0].v * 8;
    const mcusX = Math.ceil(width / mcuWidth);
    const mcusY = Math.ceil(height / mcuHeight);

    const cbw = Math.ceil(width / 2);
    const cbh = Math.ceil(height / 2);
    const yPlane = new Uint8Array(width * height);
    const cbPlane = new Uint8Array(cbw * cbh);
    const crPlane = new Uint8Array(cbw * cbh);

    const br = new BitReader(buf, startPos);
    const dcY = { dc: 0 }, dcCb = { dc: 0 }, dcCr = { dc: 0 };
    let mcu = 0;

    for (let my = 0; my < mcusY; my++) {
      for (let mx = 0; mx < mcusX; mx++) {
        if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
          dcY.dc = dcCb.dc = dcCr.dc = 0;
          br.sync();
          while (buf[br.pos] === 0xFF) br.pos += buf[br.pos + 1] === 0x00 ? 2 : 1;
        }
        for (let by = 0; by < comps[0].v; by++) {
          for (let bx = 0; bx < comps[0].h; bx++) {
            const block = decodeBlock(br, huff.dc[scanComps[0].td], huff.ac[scanComps[0].ta], qtables[comps[0].tq], dcY);
            const dct = idct(block);
            const ox = mx * mcuWidth + bx * 8;
            const oy = my * mcuHeight + by * 8;
            for (let yy = 0; yy < 8; yy++) {
              const py = oy + yy;
              if (py >= height) break;
              for (let xx = 0; xx < 8; xx++) {
                const px = ox + xx;
                if (px >= width) break;
                yPlane[py * width + px] = clamp255(dct[yy * 8 + xx] + 128);
              }
            }
          }
        }
        const blkCb = decodeBlock(br, huff.dc[scanComps[1].td], huff.ac[scanComps[1].ta], qtables[comps[1].tq], dcCb);
        const dctCb = idct(blkCb);
        const blkCr = decodeBlock(br, huff.dc[scanComps[2].td], huff.ac[scanComps[2].ta], qtables[comps[2].tq], dcCr);
        const dctCr = idct(blkCr);
        const ox = mx * (mcuWidth / 2);
        const oy = my * (mcuHeight / 2);
        for (let yy = 0; yy < 8; yy++) {
          const py = oy + yy;
          if (py >= cbh) break;
          for (let xx = 0; xx < 8; xx++) {
            const px = ox + xx;
            if (px >= cbw) break;
            cbPlane[py * cbw + px] = clamp255(dctCb[yy * 8 + xx] + 128);
            crPlane[py * cbw + px] = clamp255(dctCr[yy * 8 + xx] + 128);
          }
        }
        mcu++;
      }
    }

    const rgb = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      const cy = Math.min(cbh - 1, Math.floor(y / 2));
      for (let x = 0; x < width; x++) {
        const cx = Math.min(cbw - 1, Math.floor(x / 2));
        const yi = y * width + x;
        const yv = yPlane[yi];
        const cbv = cbPlane[cy * cbw + cx];
        const crv = crPlane[cy * cbw + cx];
        const o = yi * 3;
        rgb[o] = clamp255(yv + 1.402 * (crv - 128));
        rgb[o + 1] = clamp255(yv - 0.344136 * (cbv - 128) - 0.714136 * (crv - 128));
        rgb[o + 2] = clamp255(yv + 1.772 * (cbv - 128));
      }
    }
    return rgb;
  }

  while (pos < buf.length) {
    while (buf[pos] !== 0xFF) pos++;
    while (buf[pos] === 0xFF) pos++;
    const marker = buf[pos++];
    if (marker === 0xD9) break;
    if (marker >= 0xD0 && marker <= 0xD7) continue;
    if (marker === 0x01) continue;
    const len = readU16();
    const segStart = pos;
    const segEnd = pos + len - 2;

    if (marker === 0xDD) {
      restartInterval = readU16();
    } else if (marker === 0xC0) {
      pos++; // precision
      height = readU16();
      width = readU16();
      const nComp = buf[pos++];
      for (let i = 0; i < nComp; i++) {
        comps.push({ id: buf[pos], h: buf[pos + 1] >> 4, v: buf[pos + 1] & 15, tq: buf[pos + 2] });
        pos += 3;
      }
    } else if (marker === 0xDB) {
      while (pos < segEnd) {
        const pq = buf[pos] >> 4, tq = buf[pos] & 15;
        pos++;
        if (pq !== 0) throw new Error('16-bit quant table not supported');
        const table = new Float64Array(64);
        for (let i = 0; i < 64; i++) table[i] = buf[pos + i];
        qtables[tq] = table;
        pos += 64;
      }
    } else if (marker === 0xC4) {
      while (pos < segEnd) {
        const cls = buf[pos] >> 4, tid = buf[pos] & 15;
        pos++;
        const bits = [...buf.slice(pos, pos + 16)];
        pos += 16;
        const count = bits.reduce((a, b) => a + b, 0);
        const vals = [...buf.slice(pos, pos + count)];
        pos += count;
        const t = buildHuffTable(bits, vals);
        if (cls === 0) huff.dc[tid] = t; else huff.ac[tid] = t;
      }
    } else if (marker === 0xDA) {
      const ns = buf[pos++];
      const scanComps = [];
      for (let i = 0; i < ns; i++) {
        const id = buf[pos];
        const td = buf[pos + 1] >> 4, ta = buf[pos + 1] & 15;
        scanComps.push({ id, td, ta });
        pos += 2;
      }
      const ss = buf[pos], se = buf[pos + 1], ah = buf[pos + 2];
      if (ss !== 0 || se !== 63 || ah !== 0) throw new Error('non-baseline scan');
      pos += 3;
      if (process.env.DEBUG_JPEG) {
        console.error('scanComps', JSON.stringify(scanComps));
        console.error('qtables avail', Object.keys(qtables));
        console.error('huff dc avail', Object.keys(huff.dc), 'ac avail', Object.keys(huff.ac));
        console.error('scan data starts at', pos, 'byte', buf[pos], buf[pos + 1]);
      }
      const rgb = decodeScan(scanComps, pos);
      return { width, height, rgb };
    }
    pos = segEnd;
  }
  throw new Error('no image data found');
}

module.exports = { decodeJPEG, encodePNG };
