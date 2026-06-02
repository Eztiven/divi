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
// Tres barras ascendentes sobre gradiente teal -> verde:
//   barra 1 y 2 blancas (estrella y signo $ encima), barra 3 con los colores de
//   la bandera de Venezuela (amarillo/azul/rojo) y una estrella encima.
// "Realista": esquinas redondeadas, sombras suaves, gradientes y antialiasing
// por supersampling (3x3 muestras por pixel).

const clamp01 = (n) => Math.max(0, Math.min(1, n));
const mix = (a, b, t) => a + (b - a) * t;
const mixC = (c1, c2, t) => [mix(c1[0], c2[0], t), mix(c1[1], c2[1], t), mix(c1[2], c2[2], t)];
const smooth = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Distancia firmada a un rectangulo redondeado (negativa = adentro).
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// ¿El punto cae dentro de una estrella de 5 puntas? (poligono par-impar)
function inStar(px, py, cx, cy, R) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : R * 0.45;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;   // punta hacia arriba
    pts.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  let inside = false;
  for (let i = 0, j = 9; i < 10; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ¿El punto cae dentro de un signo $? (dos arcos en "S" + barra vertical)
function inDollar(px, py, cx, cy, h) {
  const R = h * 0.27, w = h * 0.17;             // radio de los arcos y grosor del trazo
  const cyTop = cy - R * 0.92, cyBot = cy + R * 0.92;
  const ring = (ccy, a0, a1) => {
    const d = Math.hypot(px - cx, py - ccy);
    if (Math.abs(d - R) > w / 2) return false;
    let a = (Math.atan2(ccy - py, px - cx) * 180) / Math.PI;   // 0 = este, 90 = arriba
    if (a < 0) a += 360;
    return a0 <= a1 ? a >= a0 && a <= a1 : a >= a0 || a <= a1;
  };
  if (ring(cyTop, 30, 270)) return true;        // curva superior (abre abajo-derecha)
  if (ring(cyBot, 210, 90)) return true;        // curva inferior (abre arriba-izquierda)
  // barra vertical que atraviesa el signo
  return Math.abs(px - cx) <= w * 0.32 && Math.abs(py - cy) <= R * 0.92 + R + w * 0.55;
}

function drawIcon(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);

  const topC = [16, 185, 168];     // teal claro
  const botC = [6, 95, 70];        // verde oscuro
  const white = [255, 255, 255];
  const gold = [255, 200, 87];
  const flagY = [252, 209, 22];    // bandera de Venezuela
  const flagB = [0, 74, 190];
  const flagR = [222, 35, 56];

  // Geometria en coords normalizadas 0..1
  const baseline = 0.82, hw = 0.085, rad = 0.03;
  const bars = [
    { cx: 0.24, top: 0.585, flag: false },
    { cx: 0.50, top: 0.460, flag: false },
    { cx: 0.76, top: 0.315, flag: true },
  ];
  const stars = [
    { cx: 0.24, cy: 0.495, R: 0.062 },
    { cx: 0.76, cy: 0.225, R: 0.062 },
  ];
  const dollar = { cx: 0.50, cy: 0.360, h: 0.155 };

  // Para version maskable encogemos el contenido hacia el centro (zona segura):
  // muestreamos en "coordenadas de diseño" ampliando desde el centro.
  const shrink = maskable ? 0.74 : 1;

  // Color de UNA muestra (nx, ny en 0..1)
  function sample(nx, ny) {
    // fondo: gradiente vertical + luz suave arriba-izquierda + viñeta en bordes
    let c = mixC(topC, botC, ny);
    const dl = Math.hypot(nx - 0.32, ny - 0.18);
    c = mixC(c, [255, 255, 255], 0.10 * (1 - smooth(0.0, 0.75, dl)));
    const dv = Math.hypot(nx - 0.5, ny - 0.5);
    c = mixC(c, [0, 0, 0], 0.16 * smooth(0.55, 0.85, dv));

    // coords de diseño (para encoger el contenido en la version maskable)
    const px = 0.5 + (nx - 0.5) / shrink;
    const py = 0.5 + (ny - 0.5) / shrink;

    for (const b of bars) {
      const hh = (baseline - b.top) / 2, cy = b.top + hh;
      // sombra suave proyectada abajo-derecha
      const sds = sdRoundRect(px - 0.018, py - 0.022, b.cx, cy, hw, hh, rad);
      c = mixC(c, [0, 0, 0], 0.24 * (1 - smooth(-0.005, 0.03, sds)));
      // la barra
      const sd = sdRoundRect(px, py, b.cx, cy, hw, hh, rad);
      if (sd < 0) {
        const t = clamp01((py - b.top) / (baseline - b.top));
        let fill;
        if (b.flag) {
          fill = t < 1 / 3 ? flagY : t < 2 / 3 ? flagB : flagR;
          fill = mixC(fill, [0, 0, 0], 0.10 * t);              // leve sombreado abajo
          fill = mixC(fill, [255, 255, 255], 0.18 * (1 - smooth(0, 0.10, t)));   // brillo arriba
        } else {
          fill = mixC(white, [208, 221, 230], t);              // blanco con caida sutil
        }
        // borde izquierdo iluminado (sensacion de volumen)
        const edge = smooth(0.012, 0.0, px - (b.cx - hw));
        fill = mixC(fill, [255, 255, 255], 0.25 * edge);
        c = fill;
      }
    }

    for (const s of stars) {
      if (inStar(px, py, s.cx, s.cy, s.R)) c = white;
    }
    if (inDollar(px, py, dollar.cx, dollar.cy, dollar.h)) c = gold;

    return c;
  }

  // Render con supersampling 3x3
  const SS = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const cc = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += cc[0]; g += cc[1]; b += cc[2];
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
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
