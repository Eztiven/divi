/* Divi - motor de actualizacion de tasas.
 *
 * Que hace:
 *   1. Consulta el BCV oficial, el Binance P2P (VES y COP, compra y venta) y la
 *      tasa oficial USD/COP de referencia.
 *   2. Agrega un nuevo punto al historial en public/data/history.json.
 *   3. Si el % de ahorro (BCV vs Binance) se movio mas que el umbral, o el BCV
 *      cambio, manda un aviso por Telegram.
 *
 * Se ejecuta solo (sin dependencias externas) con Node 20+ (usa fetch global).
 * En local:   node scripts/update-rates.mjs
 * En el cron: lo corre GitHub Actions cada hora.
 *
 * Variables de entorno (opcionales, para el aviso de Telegram):
 *   TELEGRAM_BOT_TOKEN   token del bot (de @BotFather)
 *   TELEGRAM_CHAT_ID     tu chat id (de @userinfobot)
 *   ALERT_THRESHOLD      puntos porcentuales para avisar (default 0.8)
 */

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "..", "public", "data", "history.json");
const ALERTS_FILE = path.join(__dirname, "..", "public", "data", "alerts.json");
const NEWS_FILE = path.join(__dirname, "..", "public", "data", "news.json");

const MAX_POINTS = 9000;          // ~1 año a 1 punto/hora
const RETENTION_DAYS = 370;       // guarda algo mas de un año para el rango "Año"
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD || "0.8");

// ---------- utilidades de red ----------
async function getJSON(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (DiviBot)",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

async function getText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (DiviBot)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

// promedio de una lista de números (ignora no-finitos). null si no hay datos.
function mean(nums) {
  const arr = nums.filter((n) => Number.isFinite(n));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Promedio de las N MEJORES ofertas. Binance ya las devuelve ordenadas por mejor
// precio, así que las primeras son las que uno realmente toma al cambiar. Promediar
// solo las 3 mejores acerca el valor a lo que de verdad se consigue (no al promedio
// de 10, que queda ~0,3-0,5 Bs por debajo de la mejor).
const TOP_N = 3;
function meanBest(prices) {
  return mean(prices.filter((n) => Number.isFinite(n)).slice(0, TOP_N));
}

// ---------- fuentes de datos ----------

// Binance P2P: PROMEDIO de las 3 mejores ofertas (Binance ya las ordena por mejor precio).
//   tradeType "BUY"  -> a como TU compras USDT  = "venta" del dolar (lo que pagas)
//   tradeType "SELL" -> a como TU vendes USDT   = "compra" del dolar (lo que te dan)
//   transAmount (fiat, opcional) -> solo ofertas que aceptan ese monto, así el precio
//     refleja lo que de verdad consigue alguien que cambia un monto típico (no las
//     mejores ofertas con mínimos enormes que un usuario normal no puede usar).
async function binanceP2P(fiat, tradeType, transAmount = null) {
  try {
    const body = { fiat, asset: "USDT", tradeType, page: 1, rows: 8, payTypes: [], publisherType: null };
    if (transAmount) body.transAmount = String(transAmount);
    const json = await getJSON(
      "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    const prices = (json?.data || []).map((d) => Number(d?.adv?.price));
    return meanBest(prices);
  } catch (e) {
    console.warn(`  ! Binance P2P ${fiat}/${tradeType} fallo: ${e.message}`);
    return null;
  }
}

// Bancos venezolanos que ofrecemos en el selector (identifier de Binance P2P).
const BANKS = ["Banesco", "Mercantil", "Provincial", "BancoDeVenezuela", "Bancamiga", "PagoMovil"];

// Promedio de precio de las ofertas P2P filtradas por UN banco concreto (y monto).
async function binanceP2PAvgBank(fiat, tradeType, payType, transAmount = null) {
  try {
    const body = { fiat, asset: "USDT", tradeType, page: 1, rows: 10, payTypes: [payType], publisherType: null };
    if (transAmount) body.transAmount = String(transAmount);
    const json = await getJSON(
      "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    );
    const prices = (json?.data || []).map((d) => Number(d?.adv?.price));
    return meanBest(prices);
  } catch (e) {
    console.warn(`  ! Binance P2P ${payType}/${tradeType} fallo: ${e.message}`);
    return null;
  }
}

// Desglose por banco: { Banesco: {v: ventaProm, c: compraProm}, ... }
//   v = BUY  (a como TÚ compras USDT  = "venta" del dólar)
//   c = SELL (a como TÚ vendes USDT   = "compra" del dólar)
//   transAmount (fiat) -> filtra por un monto típico (ver binanceP2P)
async function fetchBankBreakdown(fiat = "VES", transAmount = null) {
  const out = {};
  await Promise.all(BANKS.map(async (b) => {
    const [v, c] = await Promise.all([
      binanceP2PAvgBank(fiat, "BUY", b, transAmount),
      binanceP2PAvgBank(fiat, "SELL", b, transAmount),
    ]);
    if (v == null && c == null) return;
    out[b] = {};
    if (v != null) out[b].v = Number(v.toFixed(2));
    if (c != null) out[b].c = Number(c.toFixed(2));
  }));
  return out;
}

// "612,43320000" -> 612.4332 (coma decimal, punto de miles)
function parseVeNumber(s) {
  if (s == null) return null;
  const n = Number(String(s).trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Extrae { value, date } de un bloque (id="dolar"/"euro") del HTML del BCV.
function parseBcvBlock(html, id) {
  const i = html.indexOf(`id="${id}"`);
  if (i < 0) return { value: null, date: null };
  const block = html.slice(i, i + 800);
  const mVal = block.match(/<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i);
  // Fecha Valor: <span ... content="2026-06-22T00:00:00-04:00">
  const mDate = block.match(/Fecha\s*Valor[\s\S]*?content="([^"]+)"/i);
  return { value: mVal ? parseVeNumber(mVal[1]) : null, date: mDate ? mDate[1] : null };
}

// BCV directo: bcv.org.ve publica el VIERNES la tasa con "Fecha Valor" del LUNES
// (el próximo día hábil). Los agregadores (dolarapi) van atrasados el fin de semana,
// así que de aquí sacamos la tasa "adelantada" que alimenta el modo "lunes" de la app.
// El certificado TLS del BCV suele ser inválido -> https con rejectUnauthorized:false.
// No lanza: si falla, devuelve nulos (se usa dentro de Promise.all).
async function fetchBCVDirect() {
  try {
    const html = await new Promise((resolve, reject) => {
      const req = https.get(
        "https://www.bcv.org.ve/",
        { rejectUnauthorized: false, timeout: 20000, headers: { "user-agent": "Mozilla/5.0 (DiviBot)" } },
        (res) => {
          if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
          let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve(d));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
    });
    return { usd: parseBcvBlock(html, "dolar"), eur: parseBcvBlock(html, "euro") };
  } catch (e) {
    console.warn(`  ! BCV directo falló: ${e.message}`);
    return { usd: { value: null, date: null }, eur: { value: null, date: null } };
  }
}

// BCV oficial VIGENTE (lo que aplica HOY; alimenta el modo "viernes"). dolarapi va
// por fecha valor, así que el finde sigue dando la del último día hábil publicado.
async function fetchBCV() {
  try {
    const j = await getJSON("https://ve.dolarapi.com/v1/dolares/oficial");
    if (j?.promedio) return { value: Number(j.promedio), date: j.fechaActualizacion || null };
  } catch (e) {
    console.warn(`  ! dolarapi oficial fallo: ${e.message}`);
  }
  try {
    const j = await getJSON("https://pydolarve.org/api/v1/dollar?page=bcv");
    const v = j?.monitors?.bcv?.price;
    if (v) return { value: Number(v), date: null };
  } catch (e) {
    console.warn(`  ! pydolarve bcv fallo: ${e.message}`);
  }
  return { value: null, date: null };
}

// Paralelo VES (respaldo si Binance P2P falla).
async function fetchParaleloVES() {
  try {
    const j = await getJSON("https://ve.dolarapi.com/v1/dolares/paralelo");
    if (j?.promedio) return Number(j.promedio);
  } catch (e) {
    console.warn(`  ! dolarapi paralelo fallo: ${e.message}`);
  }
  return null;
}

// Euro BCV (oficial) y euro paralelo.
async function fetchEuro() {
  try {
    const arr = await getJSON("https://ve.dolarapi.com/v1/euros");
    const of = Array.isArray(arr) ? arr.find((x) => x.fuente === "oficial") : null;
    return { bcv: of?.promedio ?? null };
  } catch (e) {
    console.warn(`  ! euro falló: ${e.message}`);
    return { bcv: null };
  }
}

// Oficial USD/COP de referencia.
async function fetchCOPoficial() {
  try {
    const j = await getJSON("https://open.er-api.com/v6/latest/USD");
    if (j?.rates?.COP) return Number(j.rates.COP);
  } catch (e) {
    console.warn(`  ! er-api COP fallo: ${e.message}`);
  }
  return null;
}

// ---------- Telegram ----------
async function sendTelegram(text, chatId = process.env.TELEGRAM_CHAT_ID) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    console.log("  (Telegram no configurado: omito el aviso)");
    return;
  }
  try {
    await getJSON(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    console.log("  Aviso enviado por Telegram.");
  } catch (e) {
    console.warn(`  ! Telegram fallo: ${e.message}`);
  }
}

const nf = (n, frac = 2) =>
  n == null ? "--" : new Intl.NumberFormat("es-VE", {
    minimumFractionDigits: frac, maximumFractionDigits: frac,
  }).format(n);

function ahorroPct(bcv, binance) {
  if (!bcv || !binance) return null;
  return ((binance - bcv) / binance) * 100;
}

// ---------- alertas personalizadas ----------
// Metricas que el usuario puede vigilar. get(entry) saca el valor del punto actual.
const METRICS = {
  bcv:       { label: "BCV oficial",           unit: "Bs",  frac: 2, get: (e) => e.bcv },
  venta:     { label: "Binance venta (Bs)",    unit: "Bs",  frac: 2, get: (e) => e.ves_venta },
  compra:    { label: "Binance compra (Bs)",   unit: "Bs",  frac: 2, get: (e) => e.ves_compra },
  ahorro:    { label: "Ahorro BCV vs Binance", unit: "%",   frac: 2, get: (e) => ahorroPct(e.bcv, e.ves_venta) },
  copventa:  { label: "Binance venta (COP)",   unit: "COP", frac: 0, get: (e) => e.cop_venta },
  copcompra: { label: "Binance compra (COP)",  unit: "COP", frac: 0, get: (e) => e.cop_compra },
};

// nombres alternativos que el usuario puede escribir
const METRIC_ALIASES = {
  bcv: "bcv",
  venta: "venta", binance: "venta", dolar: "venta", "dólar": "venta",
  compra: "compra",
  ahorro: "ahorro", porcentaje: "ahorro",
  copventa: "copventa", peso: "copventa", cop: "copventa", pesoventa: "copventa",
  copcompra: "copcompra", pesocompra: "copcompra",
};

const canonMetric = (tok) => METRIC_ALIASES[String(tok || "").toLowerCase()] || null;

function parseOp(tok) {
  const t = String(tok || "").toLowerCase();
  if (["mayor", ">=", ">", "sube", "arriba", "alcanza"].includes(t)) return ">=";
  if (["menor", "<=", "<", "baja", "abajo"].includes(t)) return "<=";
  return null;
}
const opText = (op) => (op === ">=" ? "≥" : "≤");

let _idc = 0;
const newId = () => `a${Date.now().toString(36)}${(_idc++).toString(36)}`;

const HELP =
  "🤖 Divi — cómo crear alertas:\n\n" +
  "/alerta venta mayor 750  (avisa si Binance venta ≥ 750)\n" +
  "/alerta bcv menor 550    (avisa si BCV ≤ 550)\n" +
  "/alerta ahorro mayor 26  (avisa si el ahorro ≥ 26%)\n\n" +
  "Puedes vigilar: venta, compra, bcv, ahorro, copventa, copcompra\n\n" +
  "/lista — ver tus alertas\n" +
  "/borrar 1 — borrar la número 1\n" +
  "/activar 1 — reactivar la número 1\n" +
  "/avisos off — silenciar todo · /avisos on — reactivar";

function listText(store) {
  if (!store.alerts.length) return "No tienes alertas todavía.\n\nCrea una así: /alerta venta mayor 750";
  const estadoGlobal = store.notify === false ? "🔕 NOTIFICACIONES APAGADAS\n\n" : "";
  const lineas = store.alerts.map((a, i) => {
    const m = METRICS[a.metric];
    const estado = a.active ? "🟢 activa" : "⚪ disparada";
    return `${i + 1}. ${m.label} ${opText(a.op)} ${nf(a.value, m.frac)} ${m.unit} — ${estado}`;
  });
  return estadoGlobal + "🔔 Tus alertas:\n" + lineas.join("\n") +
    "\n\nBorrar: /borrar N · Reactivar: /activar N";
}

// Procesa un comando de texto. Devuelve el texto de respuesta (o null si no aplica).
function handleCommand(text, store) {
  const parts = String(text).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/@.*$/, ""); // quita @nombrebot

  if (["/start", "/ayuda", "/help"].includes(cmd)) return HELP;
  if (["/lista", "/list"].includes(cmd)) return listText(store);

  if (["/avisos", "/notificaciones"].includes(cmd)) {
    const v = (parts[1] || "").toLowerCase();
    if (["on", "si", "sí", "activar", "1"].includes(v)) { store.notify = true; return "🔔 Notificaciones ACTIVADAS."; }
    if (["off", "no", "silenciar", "0"].includes(v)) { store.notify = false; return "🔕 Notificaciones DESACTIVADAS. Tus alertas quedan guardadas; reactiva con /avisos on."; }
    return `Estado: notificaciones ${store.notify === false ? "🔕 apagadas" : "🔔 encendidas"}.\nUsa /avisos on  o  /avisos off`;
  }
  if (cmd === "/silenciar") { store.notify = false; return "🔕 Notificaciones DESACTIVADAS. Reactiva con /avisos on."; }

  if (["/borrar", "/del"].includes(cmd)) {
    const n = parseInt(parts[1], 10);
    if (!Number.isInteger(n) || n < 1 || n > store.alerts.length) return "Número inválido. Mira /lista.";
    const [rm] = store.alerts.splice(n - 1, 1);
    const m = METRICS[rm.metric];
    return `🗑️ Borrada: ${m.label} ${opText(rm.op)} ${nf(rm.value, m.frac)} ${m.unit}`;
  }

  if (cmd === "/activar") {
    const n = parseInt(parts[1], 10);
    if (!Number.isInteger(n) || n < 1 || n > store.alerts.length) return "Número inválido. Mira /lista.";
    store.alerts[n - 1].active = true;
    const a = store.alerts[n - 1], m = METRICS[a.metric];
    return `🟢 Reactivada: ${m.label} ${opText(a.op)} ${nf(a.value, m.frac)} ${m.unit}`;
  }

  if (["/alerta", "/alert"].includes(cmd)) {
    const metric = canonMetric(parts[1]);
    const op = parseOp(parts[2]);
    const value = parseFloat(String(parts[3] || "").replace(",", "."));
    if (!metric || !op || !Number.isFinite(value)) {
      return "No entendí. Formato: /alerta venta mayor 750\n(qué: venta, compra, bcv, ahorro, copventa, copcompra)";
    }
    const m = METRICS[metric];
    store.alerts.push({ id: newId(), metric, op, value, active: true, createdAt: new Date().toISOString() });
    return `✅ Alerta creada:\n${m.label} ${opText(op)} ${nf(value, m.frac)} ${m.unit}\n\nTe aviso cuando se cumpla. Mira todas con /lista.`;
  }

  return null; // no es un comando que manejemos
}

// Lee comandos del bot, evalua las alertas contra el punto actual y avisa.
async function processAlerts(entry, movementMsg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  let store = { offset: 0, notify: true, alerts: [] };
  try {
    store = JSON.parse(fs.readFileSync(ALERTS_FILE, "utf8"));
    if (!Array.isArray(store.alerts)) store.alerts = [];
    if (typeof store.notify !== "boolean") store.notify = true;
  } catch {
    console.log("  (no había archivo de alertas, empiezo uno nuevo)");
  }

  if (!token || !chatId) {
    console.log("  (Telegram no configurado: no se procesan alertas)");
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(store, null, 2) + "\n");
    return;
  }

  // 1) leer y aplicar comandos nuevos que escribiste al bot
  try {
    const j = await getJSON(`https://api.telegram.org/bot${token}/getUpdates?offset=${store.offset || 0}&timeout=0`);
    for (const u of (j?.result || [])) {
      store.offset = u.update_id + 1;
      const msg = u.message || u.edited_message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat?.id) !== String(chatId)) continue; // solo acepto TUS comandos
      const reply = handleCommand(msg.text, store);
      if (reply) await sendTelegram(reply, chatId);
    }
  } catch (e) {
    console.warn(`  ! getUpdates falló: ${e.message}`);
  }

  // 2) si las notificaciones están apagadas, no avisamos ni consumimos alertas
  if (store.notify === false) {
    console.log("  Notificaciones apagadas: no se evalúan alertas.");
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(ALERTS_FILE, JSON.stringify(store, null, 2) + "\n");
    return;
  }

  // 3) aviso de movimiento horario (lo decide main)
  if (movementMsg) await sendTelegram(movementMsg, chatId);

  // 4) evaluar alertas: dispara y desactiva (avisa una vez)
  let fired = 0;
  for (const a of store.alerts) {
    if (!a.active) continue;
    const m = METRICS[a.metric];
    if (!m) continue;
    const cur = m.get(entry);
    if (cur == null || Number.isNaN(cur)) continue;
    const hit = a.op === ">=" ? cur >= a.value : cur <= a.value;
    if (!hit) continue;
    a.active = false;
    a.firedAt = new Date().toISOString();
    a.firedValue = Number(cur.toFixed(m.frac));
    fired++;
    await sendTelegram(
      `🔔 <b>¡Alerta cumplida!</b>\n\n` +
      `${m.label} llegó a <b>${nf(cur, m.frac)} ${m.unit}</b>\n` +
      `(tu condición: ${opText(a.op)} ${nf(a.value, m.frac)} ${m.unit})\n\n` +
      `<i>La alerta se desactivó. Reactívala con /activar.</i>`,
      chatId
    );
  }

  store.updatedAt = new Date().toISOString();
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(store, null, 2) + "\n");
  console.log(`  Alertas: ${store.alerts.filter((a) => a.active).length} activas, ${fired} disparada(s) esta corrida.`);
}

// ---------- noticias (RSS de Google News) ----------
function xmlTag(seg, tag) {
  const m = seg.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
}
function decodeXml(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function parseRss(xml) {
  const out = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const b of blocks) {
    const seg = b.split(/<\/item>/i)[0];
    const title = decodeXml(xmlTag(seg, "title"));
    if (!title) continue;
    const link = decodeXml(xmlTag(seg, "link"));
    const source = decodeXml(xmlTag(seg, "source"));
    const pub = xmlTag(seg, "pubDate");
    const ts = pub ? Date.parse(pub) : NaN;
    out.push({ title, link, source, pubDate: pub, ts: Number.isFinite(ts) ? ts : 0 });
  }
  return out;
}
async function fetchNews() {
  const queries = ["dólar BCV Venezuela", "tasa BCV dólar", "dólar paralelo Venezuela"];
  const seen = new Set();
  const items = [];
  for (const q of queries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=es-419&gl=VE&ceid=VE:es-419`;
      const xml = await getText(url);
      for (const it of parseRss(xml)) {
        const key = it.title.toLowerCase().slice(0, 60);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
      }
    } catch (e) {
      console.warn(`  ! noticias "${q}" falló: ${e.message}`);
    }
  }
  items.sort((a, b) => b.ts - a.ts);
  return items.slice(0, 20);
}

// ---------- programa principal ----------
async function main() {
  console.log("Divi · actualizando tasas...");

  // historial actual
  let store = { updatedAt: null, history: [] };
  try {
    store = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(store.history)) store.history = [];
  } catch {
    console.log("  (no habia historial, empiezo uno nuevo)");
  }
  const prev = store.history[store.history.length - 1] || null;

  // Monto de referencia para el precio P2P: filtramos las ofertas por ~100 USDT
  // (un monto retail) para que el precio sea el que de verdad consigue la mayoría,
  // no las mejores ofertas con mínimos enormes. En Bs, usando la última tasa conocida.
  const TARGET_USDT = 100;
  const refRate = prev?.ves_venta || prev?.bcv || 800;
  const vesAmount = Math.round(TARGET_USDT * refRate);

  // consultas en paralelo
  const [bcvData, bcvDirect, vesVentaP2P, vesCompraP2P, copVentaP2P, copCompraP2P, copOficial, paralelo, euro, bankBreakdown] =
    await Promise.all([
      fetchBCV(),
      fetchBCVDirect(),
      binanceP2P("VES", "BUY", vesAmount),
      binanceP2P("VES", "SELL", vesAmount),
      binanceP2P("COP", "BUY"),
      binanceP2P("COP", "SELL"),
      fetchCOPoficial(),
      fetchParaleloVES(),
      fetchEuro(),
      fetchBankBreakdown("VES", vesAmount),
    ]);

  // arma el punto (con respaldos)
  const ves_venta = vesVentaP2P ?? paralelo ?? prev?.ves_venta ?? null;
  const ves_compra = vesCompraP2P ?? (ves_venta ? ves_venta * 0.99 : null) ?? prev?.ves_compra ?? null;
  const cop_venta = copVentaP2P ?? prev?.cop_venta ?? null;
  const cop_compra = copCompraP2P ?? (cop_venta ? cop_venta * 0.985 : null) ?? prev?.cop_compra ?? null;

  const now = new Date().toISOString();
  const entry = {
    t: now,
    // tasa VIGENTE hoy (modo "viernes"); BCV directo como último respaldo
    bcv: bcvData.value ?? bcvDirect.usd.value ?? prev?.bcv ?? null,
    bcv_date: bcvData.date ?? prev?.bcv_date ?? null,
    // tasa con fecha valor del PRÓXIMO día hábil que el BCV publica por adelantado (modo "lunes")
    bcv_next: bcvDirect.usd.value ?? prev?.bcv_next ?? null,
    bcv_next_date: bcvDirect.usd.date ?? prev?.bcv_next_date ?? null,
    ves_venta: ves_venta == null ? null : Number(ves_venta.toFixed(4)),
    ves_compra: ves_compra == null ? null : Number(ves_compra.toFixed(4)),
    cop_venta: cop_venta == null ? null : Number(cop_venta.toFixed(2)),
    cop_compra: cop_compra == null ? null : Number(cop_compra.toFixed(2)),
    cop_oficial: copOficial ?? prev?.cop_oficial ?? null,
    eur_bcv: euro.bcv != null ? Number(euro.bcv.toFixed(4)) : (bcvDirect.eur.value ?? prev?.eur_bcv ?? null),
    eur_bcv_next: bcvDirect.eur.value != null ? Number(bcvDirect.eur.value.toFixed(4)) : (prev?.eur_bcv_next ?? null),
    // promedio de Binance P2P por banco (venta/compra) para el selector de banco
    bk: (bankBreakdown && Object.keys(bankBreakdown).length) ? bankBreakdown : (prev?.bk ?? null),
  };

  console.log("  Punto nuevo:", JSON.stringify(entry));

  // agrega, recorta por retencion y por tope
  store.history.push(entry);
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  store.history = store.history.filter((r) => new Date(r.t).getTime() >= cutoff);
  if (store.history.length > MAX_POINTS) {
    store.history = store.history.slice(-MAX_POINTS);
  }
  store.updatedAt = now;
  store.note = "Datos reales generados por scripts/update-rates.mjs (cron horario).";

  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 0) + "\n");
  console.log(`  Historial guardado (${store.history.length} puntos).`);

  // ---------- aviso por Telegram ----------
  const pctNow = ahorroPct(entry.bcv, entry.ves_venta);
  const pctPrev = prev ? ahorroPct(prev.bcv, prev.ves_venta) : null;
  const bcvChanged = prev && entry.bcv != null && prev.bcv != null && entry.bcv !== prev.bcv;
  const pctMoved = pctNow != null && pctPrev != null && Math.abs(pctNow - pctPrev) >= ALERT_THRESHOLD;
  const force = process.env.FORCE_ALERT === "1";

  let movementMsg = null;
  if (pctNow != null && (force || !prev || bcvChanged || pctMoved)) {
    const dif = entry.ves_venta - entry.bcv;
    let motivo = "Actualización";
    if (!prev) motivo = "Primer registro";
    else if (bcvChanged) motivo = `BCV cambió (${nf(prev.bcv)} → ${nf(entry.bcv)})`;
    else if (pctMoved) {
      const flecha = pctNow > pctPrev ? "📈 subió" : "📉 bajó";
      motivo = `El ahorro ${flecha} ${nf(Math.abs(pctNow - pctPrev))} pts`;
    }

    movementMsg =
      `💵 <b>Divi · Dólar Venezuela</b>\n\n` +
      `🏦 BCV: <b>${nf(entry.bcv)}</b> Bs\n` +
      `🟡 Binance (venta): <b>${nf(entry.ves_venta)}</b> Bs\n` +
      `💰 Ahorro comprando al BCV: <b>${nf(pctNow)}%</b>\n` +
      `   (te ahorras Bs ${nf(dif)} por dólar)\n\n` +
      (entry.cop_venta ? `🇨🇴 Peso (Binance venta): <b>$${nf(entry.cop_venta, 0)}</b>\n\n` : "") +
      `📌 ${motivo}`;
  } else {
    console.log("  Sin cambio relevante en la tasa.");
  }

  // procesa comandos del bot, evalúa alertas personalizadas y manda los avisos
  await processAlerts(entry, movementMsg);

  // noticias del dólar/BCV (para la pestaña Noticias)
  try {
    const news = await fetchNews();
    if (news.length) {
      fs.writeFileSync(NEWS_FILE, JSON.stringify({ updatedAt: now, items: news }, null, 0) + "\n");
      console.log(`  Noticias: ${news.length} titulares guardados.`);
    } else {
      console.log("  Noticias: sin resultados esta vez.");
    }
  } catch (e) {
    console.warn(`  ! noticias falló: ${e.message}`);
  }

  console.log("Listo.");
}

main().catch((e) => {
  console.error("Error fatal:", e);
  process.exit(1);
});
