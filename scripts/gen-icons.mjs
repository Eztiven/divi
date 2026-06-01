// Genera los iconos PNG de la PWA sin dependencias externas.
// Usa solo modulos nativos de Node (zlib) para codificar PNG RGBA.
//
//   node scripts/gen-icons.mjs
//
// Salidas en public/icons/: icon-32, icon-180, icon-192, icon-512, icon-512-maskable.

import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "public", "icons");

// ---- Codificador PNG (color type 6 = RGBA, 8 bits) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Cada scanline lleva un byte de filtro (0 = none) al inicio.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- Dibujo del icono ----
// Fondo con gradiente teal -> verde y tres barras ascendentes (la mas alta dorada),
// representando el seguimiento de tasas en el tiempo.
function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);

  const topC = [16, 185, 168];   // teal claro
  const botC = [6, 95, 70];      // verde oscuro
  const white = [255, 255, 255];
  const gold = [255, 200, 87];

  // Para version maskable encogemos el contenido hacia el centro (zona segura).
  const shrink = maskable ? 0.74 : 1;
  const tx = (n) => 0.5 + (n - 0.5) * shrink;

  // Rectangulos de las barras en coords normalizadas (x0,y0,x1,y1,color,alpha).
  const baseline = 0.80;
  const bars = [
    [0.19, 0.58, 0.35, baseline, white, 1],
    [0.42, 0.46, 0.58, baseline, white, 0.92],
    [0.65, 0.30, 0.81, baseline, gold, 1],
  ].map(([x0, y0, x1, y1, c, a]) => [tx(x0), tx(y0), tx(x1), tx(y1), c, a]);

  for (let y = 0; y < size; y++) {
    const ny = y / size;
    // Gradiente vertical de fondo.
    const g = ny;
    const bg = [
      Math.round(topC[0] + (botC[0] - topC[0]) * g),
      Math.round(topC[1] + (botC[1] - topC[1]) * g),
      Math.round(topC[2] + (botC[2] - topC[2]) * g),
    ];
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      let r = bg[0], gg = bg[1], b = bg[2];

      for (const [x0, y0, x1, y1, c, a] of bars) {
        if (nx >= x0 && nx <= x1 && ny >= y0 && ny <= y1) {
          r = Math.round(r * (1 - a) + c[0] * a);
          gg = Math.round(gg * (1 - a) + c[1] * a);
          b = Math.round(b * (1 - a) + c[2] * a);
        }
      }

      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = gg;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { name: "icon-32.png", size: 32 },
  { name: "icon-180.png", size: 180 },
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "icon-512-maskable.png", size: 512, maskable: true },
];

for (const t of targets) {
  const rgba = drawIcon(t.size, { maskable: t.maskable });
  const png = encodePNG(t.size, t.size, rgba);
  fs.writeFileSync(path.join(OUT_DIR, t.name), png);
  console.log(`  ${t.name} (${png.length} bytes)`);
}

console.log("Iconos generados en public/icons/");
