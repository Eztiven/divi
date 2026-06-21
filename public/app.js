/* Divi - logica de la PWA
 * Lee el historial de tasas, calcula el % de ahorro y dibuja las graficas.
 */

// ============ CONFIG ============
// Si NO despliegas con cada actualizacion del cron, pega aqui la URL "raw" de tu
// history.json en GitHub para que la app lea los datos frescos directo del repo.
// Ej: "https://raw.githubusercontent.com/TU_USUARIO/divi/main/public/data/history.json"
// Dejalo en "" si el cron despliega a Firebase en cada corrida (entonces usa el archivo local).
const REMOTE_DATA_URL = "https://raw.githubusercontent.com/Eztiven/divi/main/public/data/history.json";
const LOCAL_DATA_URL = "./data/history.json";

// Usuario de tu bot de Telegram (sin @). Permite que el botón "Crear alerta" abra
// Telegram con el comando ya escrito. Ej: "DiviAlertasBot".
// Si lo dejas en "", el comando se copia al portapapeles para que lo pegues tú.
const TELEGRAM_BOT_USERNAME = "";

const LOCAL_ALERTS_URL = "./data/alerts.json";
const REMOTE_ALERTS_URL = REMOTE_DATA_URL ? REMOTE_DATA_URL.replace("history.json", "alerts.json") : "";

const LOCAL_NEWS_URL = "./data/news.json";
const REMOTE_NEWS_URL = REMOTE_DATA_URL ? REMOTE_DATA_URL.replace("history.json", "news.json") : "";

// ============ ESTADO ============
let DATA = null;           // { updatedAt, history: [...] }
let ALERTS = { notify: true, alerts: [] };   // { notify, offset, alerts: [...] }
let NEWS = { items: [] };  // { updatedAt, items: [...] }

// ---- moneda de referencia (USDT / Euro / ambos) ----
let MONEDA = localStorage.getItem("divi-moneda") || "usdt";   // 'usdt' | 'euro'
if (MONEDA !== "usdt" && MONEDA !== "euro") MONEDA = "usdt";
const ASSETS = {
  usdt: { bcvKey: "bcv", mktKey: "ves_venta", bcvLabel: "Dólar BCV", mktLabel: "Dólar USDT", unit: "USDT", sym: "$", nombre: "USDT", color: "#2dd4bf", bcvColor: "#ffc857" },
};
const esEuro = () => MONEDA === "euro";
const selectedAssets = () => ["usdt"];   // el euro se maneja aparte (comparación contra el dólar BCV)

// Muestra/oculta secciones según la moneda elegida.
function applyMonedaView() {
  const euro = esEuro();
  $("cardsUsd").hidden = euro;
  $("cardsEur").hidden = !euro;
  $("semaforoCard").style.display = euro ? "none" : "";
  const ca = $("card-ahorro"); if (ca) ca.style.display = euro ? "none" : "";
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// ¿hoy es fin de semana en Venezuela (GMT-4)? El BCV no publica sáb/dom.
function esFinDeSemana() {
  const ve = new Date(Date.now() - 4 * 3600 * 1000);
  const d = ve.getUTCDay();   // 0 = domingo, 6 = sábado
  return d === 0 || d === 6;
}

// ---- tasa aplicable en findes/feriados ----
let MODO_FINDE = localStorage.getItem("divi-finde") || "habil";   // 'habil' | 'viernes'
let EFF = [];   // historial con la tasa BCV "aplicable" ya resuelta

// ---- banco para el precio de Binance (promedio de ese banco) ----
// "" = todos los bancos (precio general). Si se elige uno, su promedio alimenta
// venta/compra en TODA la app (números, calculadora, % ahorro, semáforo, gráficos).
let BANCO = localStorage.getItem("divi-banco") || "";
const BANK_LABELS = {
  Banesco: "Banesco",
  Mercantil: "Mercantil",
  Provincial: "Provincial (BBVA)",
  BancoDeVenezuela: "Banco de Venezuela",
  Bancamiga: "Bancamiga",
  PagoMovil: "Pago Móvil",
};

function caracasDate(iso) { return new Date(new Date(iso).getTime() - 4 * 3600 * 1000); }
function caracasDay(iso) { return caracasDate(iso).toISOString().slice(0, 10); }
function caracasWeekday(iso) { return caracasDate(iso).getUTCDay(); }

// ¿este punto "arrastra" la tasa? (cae en finde o feriado: el BCV no publicó ese día)
function isCarried(r) {
  if (r.bcv_date) return caracasDay(r.t) !== caracasDay(r.bcv_date);
  const wd = caracasWeekday(r.t);
  return wd === 0 || wd === 6;
}

// Resuelve la tasa BCV/euro-BCV aplicable a cada punto según el modo elegido.
//  'habil'   = los días sin publicación toman la tasa del PRÓXIMO día hábil (lunes/martes).
//  'viernes' = se queda con la última publicada (lo que muestra el BCV ese día).
function computeEffective() {
  const h = (DATA && DATA.history) ? DATA.history : [];
  if (!h.length) { EFF = []; return; }
  if (MODO_FINDE === "viernes") {
    EFF = h.slice();
  } else {
    EFF = new Array(h.length);
    // Semilla: la tasa con fecha valor del PRÓXIMO día hábil que el BCV publica por
    // adelantado (el viernes ya trae la del lunes). Permite que sáb/dom muestren la
    // tasa del lunes aunque todavía no exista ese punto en el historial.
    const last = h[h.length - 1] || {};
    const lastBiz = {
      bcv: last.bcv_next != null ? last.bcv_next : null,
      eur_bcv: last.eur_bcv_next != null ? last.eur_bcv_next : null,
    };
    for (let i = h.length - 1; i >= 0; i--) {   // recorre del futuro al pasado
      const r = h[i];
      const o = { ...r };
      const carried = isCarried(r);
      ["bcv", "eur_bcv"].forEach((key) => {
        if (!carried && r[key] != null) lastBiz[key] = r[key];
        if (carried && lastBiz[key] != null) o[key] = lastBiz[key];
      });
      EFF[i] = o;
    }
  }
  // banco elegido: usa SU promedio como venta/compra en cada punto que lo tenga.
  // Los puntos viejos (sin desglose) mantienen el precio general como respaldo.
  if (BANCO) {
    for (let i = 0; i < EFF.length; i++) {
      const b = EFF[i].bk && EFF[i].bk[BANCO];
      if (!b) continue;
      EFF[i] = {
        ...EFF[i],
        ves_venta: b.v != null ? b.v : EFF[i].ves_venta,
        ves_compra: b.c != null ? b.c : EFF[i].ves_compra,
      };
    }
  }
}
const effHistory = () => (EFF.length ? EFF : ((DATA && DATA.history) || []));
const ranges = { bolivar: 7, peso: 7, ahorro: 7, dolarbcv: 7 };   // dias (o "custom") por grafica
const customRange = { bolivar: {}, peso: {}, ahorro: {}, dolarbcv: {} };  // { from, to } en ms
const charts = { bolivar: null, peso: null, ahorro: null, dolarbcv: null };

// metricas que se pueden vigilar (debe coincidir con update-rates.mjs)
const AL_METRICS = {
  bcv:       { label: "BCV oficial",           unit: "Bs",  frac: 2 },
  venta:     { label: "Binance venta (Bs)",    unit: "Bs",  frac: 2 },
  compra:    { label: "Binance compra (Bs)",   unit: "Bs",  frac: 2 },
  ahorro:    { label: "Ahorro BCV vs Binance", unit: "%",   frac: 2 },
  copventa:  { label: "Binance venta (COP)",   unit: "COP", frac: 0 },
  copcompra: { label: "Binance compra (COP)",  unit: "COP", frac: 0 },
};

// ============ HELPERS ============
const $ = (id) => document.getElementById(id);

const nfBs = new Intl.NumberFormat("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nfPct = new Intl.NumberFormat("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fmt(n, frac = 2) {
  if (n == null || Number.isNaN(n)) return "--";
  return new Intl.NumberFormat("es-VE", { minimumFractionDigits: frac, maximumFractionDigits: frac }).format(n);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2600);
}

function ahorroPct(bcv, binance) {
  if (!bcv || !binance) return null;
  return ((binance - bcv) / binance) * 100;
}

// ============ CARGA DE DATOS ============
async function loadData() {
  const bust = `?t=${Math.floor(Date.now() / 60000)}`; // cache-bust por minuto
  const candidates = [];
  if (REMOTE_DATA_URL) candidates.push(REMOTE_DATA_URL + bust);
  candidates.push(LOCAL_DATA_URL + bust);

  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const json = await res.json();
      if (json && Array.isArray(json.history) && json.history.length) {
        DATA = json;
        return true;
      }
    } catch (_) { /* intenta el siguiente */ }
  }
  return false;
}

// ============ RENDER NUMEROS ============
function renderNumbers() {
  const h = effHistory();
  const last = h[h.length - 1];

  // ---- Bolívar / Euro ----
  if (esEuro()) {
    const e = last.eur_bcv, d = last.bcv;
    const ratio = (e && d) ? e / d : null;
    $("heroLabel").textContent = "1 euro al BCV equivale a";
    $("ahorroPct").textContent = ratio != null ? `${fmt(ratio, 3)} $` : "--";
    $("ahorroDetalle").textContent = (e && d)
      ? `Euro ${fmt(e)} Bs · Dólar ${fmt(d)} Bs · +${fmt(e - d)} Bs por unidad`
      : "";
    $("eurBcvValue").textContent = fmt(e);
    $("eurUsdBcvValue").textContent = fmt(d);
  } else {
    const a = ASSETS.usdt;
    const pBcv = last[a.bcvKey], pMkt = last[a.mktKey];
    const pct = ahorroPct(pBcv, pMkt);
    $("ahorroPct").textContent = pct == null ? "--%" : `${fmt(pct)}%`;
    $("heroLabel").textContent = `Te ahorras comprando al BCV vs ${a.nombre}`;
    if (pBcv && pMkt) {
      $("ahorroDetalle").textContent =
        `${a.bcvLabel} ${fmt(pBcv)} · ${a.mktLabel} ${fmt(pMkt)} → ahorras Bs ${fmt(pMkt - pBcv)}`;
    }
    $("bcvValue").textContent = fmt(last.bcv);
    $("vesVentaValue").textContent = fmt(last.ves_venta);
    $("vesCompraValue").textContent = fmt(last.ves_compra);
    // badge del banco activo en la tarjeta USDT (BANK_LABELS es constante confiable)
    const cn = $("usdtCardName");
    if (cn) cn.innerHTML = BANCO
      ? `Dólar USDT <span class="card-bank">· ${BANK_LABELS[BANCO] || BANCO}</span>`
      : "Dólar USDT";
  }
  // nota del banco elegido (precio Binance)
  const bn = $("bancoNote");
  if (bn) {
    if (!BANCO) {
      bn.textContent = "Mostrando el precio general (todos los bancos).";
    } else if (last.bk && last.bk[BANCO]) {
      bn.textContent = `Promedio de ${BANK_LABELS[BANCO] || BANCO} en Binance (venta y compra).`;
    } else {
      bn.textContent = `Aún no hay datos de ${BANK_LABELS[BANCO] || BANCO}; mostrando el precio general por ahora.`;
    }
  }
  applyMonedaView();
  // aviso de fin de semana
  const wn = $("weekendNote");
  if (esFinDeSemana()) {
    wn.hidden = false;
    const cual = MODO_FINDE === "viernes"
      ? "estás viendo la del viernes (último día publicado)"
      : "estás viendo la del próximo día hábil (lunes)";
    wn.textContent = `📅 Fin de semana: el BCV no cambia sáb/dom — ${cual}. El USDT/Euro sí siguen moviéndose.`;
  } else {
    wn.hidden = true;
  }

  // ---- Peso ----
  $("copVentaHero").textContent = last.cop_venta ? `$ ${fmt(last.cop_venta, 0)}` : "--";
  $("copVentaValue").textContent = fmt(last.cop_venta, 0);
  $("copCompraValue").textContent = fmt(last.cop_compra, 0);
  $("copOficialValue").textContent = fmt(last.cop_oficial, 0);

  // variacion del peso (Binance venta) en las ultimas 24h
  const ref = findRef(h, "cop_venta", 24 * 3600 * 1000);
  if (ref != null && last.cop_venta) {
    const v = ((last.cop_venta - ref) / ref) * 100;
    const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "■";
    const cls = v > 0 ? "down" : v < 0 ? "up" : "";
    $("copVariacion").innerHTML =
      `<span class="${cls}">${arrow} ${fmt(Math.abs(v))}%</span> en 24 h`;
  } else {
    $("copVariacion").textContent = "Sin variación registrada aún";
  }

  // ---- Semáforo ----
  renderSemaforo();

  // ---- Footer ----
  const upIso = DATA.updatedAt || last.t;
  $("updatedAt").textContent = `${formatStamp(upIso)} (${timeAgo(new Date(upIso).getTime())})`;
}

// ============ SEMÁFORO: ¿buen día para comprar? ============
function renderSemaforo() {
  const card = $("semaforoCard");
  const dotVerdict = $("semVerdict");
  const detail = $("semDetail");
  if (esEuro()) return;   // el semáforo es para el dólar
  const prim = ASSETS.usdt;
  const h = effHistory();
  const last = h[h.length - 1];
  const cur = ahorroPct(last[prim.bcvKey], last[prim.mktKey]);

  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const vals = h
    .filter((r) => new Date(r.t).getTime() >= cutoff)
    .map((r) => ahorroPct(r[prim.bcvKey], r[prim.mktKey]))
    .filter((v) => v != null);

  if (cur == null || vals.length < 3) {
    card.className = "semaforo-card na";
    dotVerdict.textContent = "Reuniendo datos…";
    detail.textContent = "En unas horas tendré suficiente historial para darte la recomendación.";
    return;
  }

  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const min = Math.min(...vals), max = Math.max(...vals);
  const diff = cur - avg;
  const pos = max > min ? (cur - min) / (max - min) : 0.5;

  let color, verdict;
  if (pos >= 0.66 || diff >= 0.8) { color = "green"; verdict = "🟢 Buen día para comprar"; }
  else if (pos <= 0.33 || diff <= -0.8) { color = "red"; verdict = "🔴 Día caro — mejor esperar"; }
  else { color = "yellow"; verdict = "🟡 Día normal"; }

  card.className = "semaforo-card " + color;
  dotVerdict.textContent = verdict;
  const signo = diff >= 0 ? "+" : "";
  detail.textContent =
    `Ahorro hoy ${fmt(cur)}% · promedio 7 días ${fmt(avg)}% (${signo}${fmt(diff)} pts). ` +
    `Rango semanal: ${fmt(min)}–${fmt(max)}%.`;
}

// valor de referencia ~N ms atras para calcular variacion
function findRef(history, key, msAgo) {
  const cutoff = Date.now() - msAgo;
  let ref = null;
  for (const r of history) {
    if (r[key] == null) continue;
    if (new Date(r.t).getTime() <= cutoff) ref = r[key];
    else { if (ref == null) ref = r[key]; break; }
  }
  // si todo es mas reciente que el corte, usa el primer punto disponible
  if (ref == null) {
    const first = history.find((r) => r[key] != null);
    ref = first ? first[key] : null;
  }
  return ref;
}

// ============ GRAFICAS ============
function filterByRange(history, days) {
  if (!days || days <= 0) return history;
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const out = history.filter((r) => new Date(r.t).getTime() >= cutoff);
  return out.length ? out : history.slice(-2);
}

// Datos a graficar según el rango elegido (número de días o "custom" con fechas).
function rangeData(target) {
  const hist = effHistory();
  const mode = ranges[target];
  if (mode === "custom") {
    const c = customRange[target] || {};
    let arr = hist.slice();
    if (c.from != null) arr = arr.filter((r) => new Date(r.t).getTime() >= c.from);
    if (c.to != null) arr = arr.filter((r) => new Date(r.t).getTime() <= c.to);
    return arr.length ? arr : hist.slice(-2);
  }
  return filterByRange(hist, Number(mode));
}

// "días" que usa labelFor para decidir el formato de las etiquetas.
function labelDays(target, data) {
  const mode = ranges[target];
  if (mode !== "custom") return Number(mode);
  if (data.length < 2) return 1;
  const span = (new Date(data[data.length - 1].t) - new Date(data[0].t)) / 86400000;
  return span <= 1 ? 1 : span;
}

function labelFor(tISO, days) {
  const d = new Date(tISO);
  if (days === 1) {
    return d.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("es-VE", { day: "2-digit", month: "2-digit" }) +
    " " + d.toLocaleTimeString("es-VE", { hour: "2-digit" }) + "h";
}

const chartBase = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { labels: { color: "#93a1b8", boxWidth: 12, font: { size: 11 } } },
    tooltip: {
      backgroundColor: "#182338",
      borderColor: "#233149",
      borderWidth: 1,
      titleColor: "#e8eef7",
      bodyColor: "#e8eef7",
      callbacks: {
        label: (c) => `${c.dataset.label}: ${fmt(c.parsed.y, c.dataset._frac ?? 2)}`,
      },
    },
  },
  scales: {
    x: { ticks: { color: "#6b7a93", maxTicksLimit: 6, font: { size: 10 } }, grid: { color: "rgba(35,49,73,.5)" } },
    y: { ticks: { color: "#6b7a93", font: { size: 10 } }, grid: { color: "rgba(35,49,73,.5)" } },
  },
};

function renderBolivarChart() {
  if (typeof Chart === "undefined") return;   // CDN bloqueado / sin conexión
  const data = rangeData("bolivar");
  const days = labelDays("bolivar", data);
  const labels = data.map((r) => labelFor(r.t, days));
  let ds, afterBody, title;

  if (esEuro()) {
    // Euro BCV vs Dólar BCV (ambos oficiales)
    ds = [
      { label: "Euro BCV", data: data.map((r) => r.eur_bcv), borderColor: "#a78bfa", backgroundColor: hexA("#a78bfa", 0.12), fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 2 },
      { label: "Dólar BCV", data: data.map((r) => r.bcv), borderColor: "#ffc857", backgroundColor: "transparent", fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2, borderDash: [5, 4], _frac: 2 },
    ];
    afterBody = (items) => {
      const r = data[items[0].dataIndex];
      if (!r || !r.eur_bcv || !r.bcv) return "";
      return ["", `1 € = ${fmt(r.eur_bcv / r.bcv, 3)} $`, `Diferencia: ${fmt(r.eur_bcv - r.bcv)} Bs`];
    };
    title = "💶 Euro BCV vs Dólar BCV (en Bs)";
  } else {
    const a = ASSETS.usdt;
    ds = [
      { label: a.mktLabel, data: data.map((r) => r[a.mktKey]), borderColor: a.color, backgroundColor: hexA(a.color, 0.12), fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 2 },
      { label: a.bcvLabel, data: data.map((r) => r[a.bcvKey]), borderColor: a.bcvColor, backgroundColor: "transparent", fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2, borderDash: [5, 4], _frac: 2 },
    ];
    afterBody = (items) => {
      const r = data[items[0].dataIndex];
      if (!r || !r[a.bcvKey] || !r[a.mktKey]) return "";
      const bv = r[a.bcvKey], mk = r[a.mktKey];
      return ["", `${a.sym}1 BCV = ${fmt(bv / mk, 3)} ${a.unit}`, `Dif: ${fmt(mk - bv)} Bs (${fmt(((mk - bv) / mk) * 100)}%)`];
    };
    title = "💵 Dólar BCV vs Dólar USDT (en Bs)";
  }

  const opts = {
    ...chartBase,
    plugins: {
      ...chartBase.plugins,
      tooltip: { ...chartBase.plugins.tooltip, callbacks: { ...chartBase.plugins.tooltip.callbacks, afterBody } },
    },
  };
  const t = $("bolivarChartTitle"); if (t) t.textContent = title;
  const cfg = { type: "line", data: { labels, datasets: ds }, options: opts };
  charts.bolivar?.destroy();
  charts.bolivar = new Chart($("bolivarChart"), cfg);
}

function renderPesoChart() {
  if (typeof Chart === "undefined") return;
  const data = rangeData("peso");
  const days = labelDays("peso", data);
  const labels = data.map((r) => labelFor(r.t, days));
  const cfg = {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Binance (venta)",
          data: data.map((r) => r.cop_venta),
          borderColor: "#2dd4bf",
          backgroundColor: "rgba(45,212,191,.12)",
          fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 0,
        },
        {
          label: "Binance (compra)",
          data: data.map((r) => r.cop_compra),
          borderColor: "#60a5fa",
          backgroundColor: "transparent",
          fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 0,
        },
      ],
    },
    options: chartBase,
  };
  charts.peso?.destroy();
  charts.peso = new Chart($("pesoChart"), cfg);
}

function renderAhorroChart() {
  if (typeof Chart === "undefined") return;
  if (esEuro()) return;   // el ahorro % es para el dólar
  const data = rangeData("ahorro");
  const days = labelDays("ahorro", data);
  const labels = data.map((r) => labelFor(r.t, days));
  const assets = selectedAssets();
  const ds = assets.map((k) => {
    const a = ASSETS[k];
    return {
      label: "Ahorro " + a.nombre + " %",
      data: data.map((r) => ahorroPct(r[a.bcvKey], r[a.mktKey])),
      borderColor: a.color,
      backgroundColor: hexA(a.color, 0.14),
      fill: assets.length === 1, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 2,
    };
  });
  // línea de promedio solo si hay una moneda
  if (assets.length === 1) {
    const a = ASSETS[assets[0]];
    const serie = data.map((r) => ahorroPct(r[a.bcvKey], r[a.mktKey])).filter((v) => v != null);
    const avg = serie.length ? serie.reduce((x, y) => x + y, 0) / serie.length : null;
    ds.push({
      label: "Promedio", data: data.map(() => avg),
      borderColor: "#ffc857", backgroundColor: "transparent",
      fill: false, pointRadius: 0, borderWidth: 1.5, borderDash: [5, 4], _frac: 2,
    });
  }
  const cfg = { type: "line", data: { labels, datasets: ds }, options: chartBase };
  charts.ahorro?.destroy();
  charts.ahorro = new Chart($("ahorroChart"), cfg);
}

function renderDolarChart() {
  if (typeof Chart === "undefined") return;
  const data = rangeData("dolarbcv");
  const days = labelDays("dolarbcv", data);
  const labels = data.map((r) => labelFor(r.t, days));
  let ds, title;
  if (esEuro()) {
    // cuántos dólares vale 1 euro al BCV (eur_bcv / usd_bcv)
    ds = [{
      label: "1 € en dólares (BCV)",
      data: data.map((r) => (r.eur_bcv && r.bcv) ? r.eur_bcv / r.bcv : null),
      borderColor: "#a78bfa", backgroundColor: hexA("#a78bfa", 0.14),
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 3,
    }];
    title = "🪙 1 euro en dólares (BCV)";
  } else {
    const a = ASSETS.usdt;
    ds = [{
      label: `${a.sym}1 BCV en ${a.unit}`,
      data: data.map((r) => (r[a.bcvKey] && r[a.mktKey]) ? r[a.bcvKey] / r[a.mktKey] : null),
      borderColor: a.color, backgroundColor: hexA(a.color, 0.14),
      fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 3,
    }];
    title = "🪙 Valor del dólar BCV en USDT";
  }
  const t = $("dolarChartTitle"); if (t) t.textContent = title;
  const cfg = { type: "line", data: { labels, datasets: ds }, options: chartBase };
  charts.dolarbcv?.destroy();
  charts.dolarbcv = new Chart($("dolarChart"), cfg);
}

function renderCharts() {
  renderBolivarChart();
  renderAhorroChart();
  renderDolarChart();
  renderPesoChart();
}

function formatStamp(iso) {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toLocaleString("es-VE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ============ UI EVENTS ============
function activateTab(btn, focus = false) {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((b) => {
    const on = b === btn;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
    b.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
  $(`tab-${btn.dataset.tab}`).classList.add("active");
  if (focus) btn.focus();
  // redibuja para que Chart.js calcule bien el tamaño al hacerse visible
  if (btn.dataset.tab === "peso") renderPesoChart();
  else if (btn.dataset.tab === "alertas") loadAlerts();
  else if (btn.dataset.tab === "calc") renderCalc();
  else if (btn.dataset.tab === "noticias") loadNews();
  else { renderBolivarChart(); renderAhorroChart(); renderDolarChart(); }
}

function setupTabs() {
  const tabs = [...document.querySelectorAll(".tab")];
  tabs.forEach((btn, i) => {
    btn.addEventListener("click", () => activateTab(btn));
    // navegación por teclado entre pestañas (patrón ARIA tablist)
    btn.addEventListener("keydown", (e) => {
      let j = null;
      if (e.key === "ArrowRight") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      if (j === null) return;
      e.preventDefault();
      activateTab(tabs[j], true);
    });
  });
}

function renderTarget(target) {
  if (target === "peso") renderPesoChart();
  else if (target === "ahorro") renderAhorroChart();
  else if (target === "dolarbcv") renderDolarChart();
  else renderBolivarChart();
}

function setupRanges() {
  document.querySelectorAll(".range-bar").forEach((bar) => {
    const target = bar.dataset.target;
    const panel = bar.parentElement.querySelector(".custom-range");

    bar.querySelectorAll(".range-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        bar.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        const r = btn.dataset.range;
        if (r === "custom") {
          ranges[target] = "custom";
          if (panel) panel.hidden = false;
        } else {
          ranges[target] = Number(r);
          if (panel) panel.hidden = true;
        }
        renderTarget(target);
      });
    });

    if (panel) {
      const from = panel.querySelector(".cr-from");
      const to = panel.querySelector(".cr-to");
      const onChange = () => {
        let f = from.value ? new Date(from.value + "T00:00:00").getTime() : null;
        let t = to.value ? new Date(to.value + "T23:59:59").getTime() : null;
        if (f != null && t != null && f > t) [f, t] = [t, f];   // tolera fechas invertidas
        customRange[target] = { from: f, to: t };
        ranges[target] = "custom";
        renderTarget(target);
      };
      from.addEventListener("change", onChange);
      to.addEventListener("change", onChange);
    }
  });
}

let _refreshing = false;   // evita cargas solapadas (polling + manual + visibilitychange)
async function refresh(showToast = true) {
  if (_refreshing) return;
  _refreshing = true;
  const btn = $("refreshBtn");
  btn.classList.add("spin");
  try {
    const ok = await loadData();
    if (ok) {
      computeEffective();
      renderNumbers();
      renderCharts();
      renderCalc();        // la calculadora también usa la tasa nueva
      if (showToast) toast("Datos actualizados");
    } else {
      toast("No se pudieron cargar los datos");
    }
  } finally {
    btn.classList.remove("spin");
    _refreshing = false;
  }
}

// ============ ALERTAS ============
async function loadAlerts() {
  const bust = `?t=${Math.floor(Date.now() / 60000)}`;
  const urls = [];
  if (REMOTE_ALERTS_URL) urls.push(REMOTE_ALERTS_URL + bust);
  urls.push(LOCAL_ALERTS_URL + bust);
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && Array.isArray(j.alerts)) { ALERTS = j; break; }
    } catch (_) { /* intenta el siguiente */ }
  }
  renderAlerts();
}

function renderAlerts() {
  const on = ALERTS.notify !== false;
  const toggle = $("notifyToggle");
  toggle.setAttribute("aria-checked", on ? "true" : "false");
  $("notifyState").textContent = on
    ? "Activadas — te aviso por Telegram"
    : "Desactivadas — no se envían avisos";

  const list = $("alertList");
  const arr = ALERTS.alerts || [];
  if (!arr.length) {
    list.innerHTML = '<p class="muted small">No tienes alertas todavía. Crea una arriba 👆</p>';
    return;
  }
  list.innerHTML = "";
  arr.forEach((a, i) => {
    const m = AL_METRICS[a.metric] || { label: a.metric, unit: "", frac: 2 };
    const active = a.active !== false;
    const op = a.op === ">=" ? "≥" : "≤";
    const item = document.createElement("div");
    item.className = "alert-item" + (active ? "" : " off");
    item.innerHTML =
      `<div class="ai-main">
         <div class="ai-title">${escapeHtml(m.label)} ${op} ${fmt(a.value, m.frac)} ${escapeHtml(m.unit)}</div>
         <div class="ai-sub"><span class="badge ${active ? "on" : "fired"}">${active ? "activa" : "disparada"}</span></div>
       </div>
       <button class="ai-btn" data-act="${active ? "del" : "act"}" data-i="${i + 1}">${active ? "🗑️ Borrar" : "↺ Activar"}</button>`;
    list.appendChild(item);
  });
  list.querySelectorAll(".ai-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = btn.dataset.i;
      if (btn.dataset.act === "del") sendBotCommand(`/borrar ${i}`, "Borrando alerta…");
      else sendBotCommand(`/activar ${i}`, "Reactivando alerta…");
    });
  });
}

// Manda un comando al bot: abre Telegram con el texto listo (o lo copia).
function sendBotCommand(cmd, note) {
  if (TELEGRAM_BOT_USERNAME) {
    const url = `https://t.me/${TELEGRAM_BOT_USERNAME}?text=${encodeURIComponent(cmd)}`;
    window.open(url, "_blank", "noopener");
    toast(note || "Abriendo Telegram… dale enviar al comando.");
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(cmd)
      .then(() => toast("Comando copiado, pégalo en tu bot: " + cmd))
      .catch(() => toast("Envíale a tu bot: " + cmd));
  } else {
    toast("Envíale a tu bot: " + cmd);
  }
}

function createAlert() {
  const metric = $("alMetric").value;
  const op = $("alOp").value;            // "mayor" | "menor"
  const value = parseFloat(String($("alValue").value).replace(",", "."));
  if (!Number.isFinite(value)) { toast("Escribe un valor válido"); return; }
  sendBotCommand(`/alerta ${metric} ${op} ${value}`, "Abriendo Telegram con tu alerta…");
  $("alHint").textContent = "Enviado. Aparecerá en la lista tras la próxima revisión (hasta 1 h).";
}

function toggleNotify() {
  const next = ALERTS.notify === false;  // si estaba apagado -> encender
  sendBotCommand(`/avisos ${next ? "on" : "off"}`, next ? "Activando notificaciones…" : "Silenciando notificaciones…");
  ALERTS.notify = next;                  // feedback inmediato (el bot lo confirma luego)
  renderAlerts();
}

function setupAlerts() {
  $("alCreate").addEventListener("click", createAlert);
  $("notifyToggle").addEventListener("click", toggleNotify);
  $("alRefresh").addEventListener("click", () => { loadAlerts(); toast("Alertas actualizadas"); });
}

// ============ CALCULADORA (casillas enlazadas) ============
let _calcLock = false;   // evita bucles al rellenar las casillas
// Acepta "554,43", "554.43" y "55.442,58" (formato venezolano con miles).
function calcNum(s) {
  s = String(s).trim().replace(/\s/g, "");
  if (!s) return 0;
  if (s.includes(",") && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  else if (s.includes(",")) s = s.replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
const round2 = (n) => Number(n.toFixed(2));
// Formatea para escribir en una casilla editable: coma decimal, sin separador de miles.
const toField = (n, frac = 2) => Number(n.toFixed(frac)).toString().replace(".", ",");

// Deja solo dígitos y UN único separador decimal (quita comas/puntos de más).
function sanitizeNum(v) {
  v = String(v).replace(/[^\d.,]/g, "");
  const i = v.search(/[.,]/);
  if (i === -1) return v;
  return v.slice(0, i + 1) + v.slice(i + 1).replace(/[.,]/g, "");
}
// Pesos (COP): solo dígitos y punto de mil (NO coma, sin decimales).
const sanitizeCop = (v) => String(v).replace(/[^\d.]/g, "");
const copNum = (s) => parseInt(String(s).replace(/\D/g, ""), 10) || 0;

// Limpia el campo en vivo conservando la posición del cursor.
function sanitizeField(el, fn = sanitizeNum) {
  const clean = fn(el.value);
  if (clean === el.value) return;
  const diff = el.value.length - clean.length;
  const pos = Math.max(0, (el.selectionStart || clean.length) - diff);
  el.value = clean;
  try { el.setSelectionRange(pos, pos); } catch (_) {}
}

// Al enfocar una casilla, deja el cursor al final (facilita borrar/editar).
function cursorAlFinal(el) {
  el.addEventListener("focus", () => setTimeout(() => {
    const v = el.value; try { el.setSelectionRange(v.length, v.length); } catch (_) {}
  }, 0));
}
const calcRow = (label, value, unit, frac = 2) =>
  `<div class="calc-row"><span class="cr-label">${label}</span>` +
  `<span class="cr-value">${fmt(value, frac)}<small>${unit}</small></span></div>`;

// source = "usd" | "bs" | "cop": casilla que el usuario editó (no se reescribe).
// La casilla de bolívares usa la tasa BCV (es el valor oficial del dólar).
function recalc(source) {
  if (_calcLock || !DATA) return;
  const h = effHistory();
  const last = h[h.length - 1];
  const bcv = last.bcv, ves = last.ves_venta, vesCompra = last.ves_compra, cop = last.cop_venta;

  // todo se convierte pasando por dólares (USD)
  let usd = 0;
  if (source === "usd") usd = calcNum($("calcUsd").value);
  else if (source === "bs") usd = bcv ? calcNum($("calcBs").value) / bcv : 0;   // Bs ↔ BCV
  else if (source === "cop") usd = cop ? copNum($("calcCop").value) / cop : 0;   // COP ↔ Binance

  _calcLock = true;
  if (source !== "usd") $("calcUsd").value = usd ? toField(usd, 2) : "";
  if (source !== "bs")  $("calcBs").value  = (usd && bcv) ? toField(usd * bcv, 2) : "";
  if (source !== "cop") $("calcCop").value = (usd && cop) ? fmt(usd * cop, 0) : "";   // pesos con punto de mil
  _calcLock = false;

  const ref = $("calcRef");
  if (!usd) { ref.innerHTML = '<p class="muted small">Escribe un monto arriba 👆</p>'; return; }

  const bsBcv = usd * bcv;               // lo que cuestan al BCV
  const usdtEnBinance = ves ? bsBcv / ves : 0;   // esos Bs convertidos a USDT en Binance
  const pct = ves ? ((ves - bcv) / ves) * 100 : 0;

  let rows = "";
  if (ves) rows += calcRow(`🔄 Esos ${fmt(bsBcv)} Bs en Binance`, usdtEnBinance, "USDT");
  if (ves) rows += calcRow(`🟡 Comprar ${fmt(usd)} USDT en Binance cuesta`, usd * ves, "Bs");
  if (vesCompra) rows += calcRow(`🟢 Vender ${fmt(usd)} USDT en Binance te da`, usd * vesCompra, "Bs");
  if (ves) rows += calcRow("💰 Ahorro comprando al BCV", pct, "%");
  ref.innerHTML = rows;
}

let _calcSource = "usd";   // última casilla que editó el usuario
function renderCalc() { recalc(_calcSource); }   // refresco al abrir la pestaña / cargar datos

function setupCalc() {
  const wire = (id, src, fn) => {
    const el = $(id);
    el.addEventListener("input", () => { _calcSource = src; sanitizeField(el, fn); recalc(src); });
    cursorAlFinal(el);
  };
  wire("calcUsd", "usd", sanitizeNum);
  wire("calcBs", "bs", sanitizeNum);
  wire("calcCop", "cop", sanitizeCop);   // pesos: solo dígitos y punto de mil
}

// ============ NOTICIAS ============
function stripSource(title) {
  return String(title).replace(/\s+-\s+[^-]+$/, "").trim() || String(title);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 60) return `hace ${Math.max(1, min)} min`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `hace ${hrs} h`;
  const dias = Math.round(hrs / 24);
  return `hace ${dias} d`;
}

async function loadNews() {
  const bust = `?t=${Math.floor(Date.now() / 300000)}`; // cache-bust cada 5 min
  const urls = [];
  if (REMOTE_NEWS_URL) urls.push(REMOTE_NEWS_URL + bust);
  urls.push(LOCAL_NEWS_URL + bust);
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const j = await res.json();
      if (j && Array.isArray(j.items)) { NEWS = j; break; }
    } catch (_) { /* siguiente */ }
  }
  renderNews();
}
function renderNews() {
  const list = $("newsList");
  const items = NEWS.items || [];
  if (!items.length) {
    list.innerHTML = '<p class="muted small">No hay noticias por ahora. Vuelve más tarde.</p>';
    return;
  }
  list.innerHTML = "";
  items.forEach((n) => {
    const a = document.createElement("a");
    a.className = "news-item";
    a.href = n.link || "#";
    a.target = "_blank";
    a.rel = "noopener";
    a.innerHTML =
      `<div class="news-title">${escapeHtml(stripSource(n.title))}</div>` +
      `<div class="news-meta">${escapeHtml(n.source || "")}${n.source && n.ts ? " · " : ""}${timeAgo(n.ts)}</div>`;
    list.appendChild(a);
  });
}

// ============ CONTADOR DE PRÓXIMA ACTUALIZACIÓN ============
// cron-job.org dispara el workflow a los minutos 0, 15, 30 y 45 de cada hora
// (UTC). El contador apunta a la LLEGADA estimada del dato (corrida + ~3,5 min de
// commit y propagación). Desde que dispara el cron se sondea en silencio por
// detrás: apenas aterriza el dato nuevo, el reloj salta a la próxima corrida sin
// quedarse pegado en "actualizando".
const CRON_MINUTES = [0, 15, 30, 45];
const ARRIVAL_MS = 3.5 * 60000;   // retraso típico: corrida + commit + CDN

function nextCronTime() {
  const now = Date.now();
  for (const m of CRON_MINUTES) {
    const next = new Date();
    next.setUTCMinutes(m, 0, 0);
    if (next.getTime() > now) return next.getTime();
  }
  // ya pasaron todas las de esta hora: la primera de la próxima
  const next = new Date();
  next.setUTCMinutes(CRON_MINUTES[0], 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime();
}

let _lastAutoRefresh = 0;
let _esperando = false;   // hay una corrida reciente cuyo dato aún no llega

function tickCountdown() {
  const el = $("nextUpdate");
  if (!el) return;
  const now = Date.now();
  const nextCron = nextCronTime();
  const lastCron = nextCron - 15 * 60000;   // la corrida más reciente
  const upTs = DATA ? new Date(DATA.updatedAt || 0).getTime() : 0;

  // ¿el dato de la última corrida ya llegó?
  const fresco = upTs >= lastCron;
  const enVentana = now - lastCron <= 6 * 60000;   // espera razonable por corrida

  if (!fresco && enVentana) {
    // corrida en curso: sondea en silencio cada 25 s hasta que aterrice el commit
    _esperando = true;
    if (now - _lastAutoRefresh > 25000) {
      _lastAutoRefresh = now;
      refresh(false);
    }
  } else {
    if (_esperando && fresco) toast("Tasas actualizadas ✅");
    _esperando = false;
  }

  // el reloj apunta a la llegada estimada del dato (corrida + ~3,5 min); solo si
  // el dato se retrasa más de eso se muestra "actualizando"
  const target = ((fresco || !enVentana) ? nextCron : lastCron) + ARRIVAL_MS;
  const ms = target - now;
  if (ms > 0) {
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    el.textContent = `⏳ Próxima actualización en ${m}:${String(s).padStart(2, "0")} min`;
  } else {
    el.textContent = "🔄 Actualizando datos…";
  }

  // Con corridas cada 15 min, si los datos llevan >50 min sin cambiar es que
  // se saltaron varias: avisa y reintenta la carga cada 3 min hasta ponerse al día.
  const stale = upTs && now - upTs > 50 * 60000;
  const note = $("staleNote");
  if (note) {
    note.hidden = !stale;
    if (stale) {
      note.textContent = `⚠️ Los datos tienen ${timeAgo(upTs).replace("hace ", "")} de retraso ` +
        `(GitHub a veces salta corridas del cron). Reintentando automáticamente…`;
      if (Date.now() - _lastAutoRefresh > 3 * 60000) {
        _lastAutoRefresh = Date.now();
        refresh(false);
      }
    }
  }
}

// ============ AVISO DE NUEVA VERSIÓN DE LA APP ============
// El sw.js nuevo se activa solo (skipWaiting); aquí solo avisamos para que el
// usuario recargue y cargue el app shell actualizado.
function showUpdateBanner() {
  if ($("updateBanner")) return;   // ya está visible
  const bar = document.createElement("div");
  bar.id = "updateBanner";
  bar.className = "update-banner";
  bar.innerHTML =
    '<span>✨ Hay una nueva versión de Divi</span>' +
    '<button id="updateBtn">Actualizar</button>';
  document.body.appendChild(bar);
  $("updateBtn").addEventListener("click", () => location.reload());
}

// ============ MODO FIN DE SEMANA / FERIADO ============
function setupFinde() {
  const sel = $("findeSelect");
  if (!sel) return;
  sel.value = MODO_FINDE;
  sel.addEventListener("change", () => {
    MODO_FINDE = sel.value;
    localStorage.setItem("divi-finde", MODO_FINDE);
    if (DATA) { computeEffective(); renderNumbers(); renderCharts(); }
  });
}

// ============ SELECTOR DE BANCO (precio Binance) ============
// Hay dos selectores (Bolívar y Calculadora) que comparten estado: clase .banco-select.
function setupBanco() {
  const sels = [...document.querySelectorAll(".banco-select")];
  if (!sels.length) return;
  const opts = '<option value="">Todos los bancos (general)</option>' +
    Object.entries(BANK_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
  sels.forEach((sel) => {
    sel.innerHTML = opts;            // BANK_LABELS son constantes confiables
    sel.value = BANCO;
    sel.addEventListener("change", () => {
      BANCO = sel.value;
      localStorage.setItem("divi-banco", BANCO);
      sels.forEach((s) => { if (s !== sel) s.value = BANCO; });   // mantiene ambos en sync
      if (DATA) { computeEffective(); renderNumbers(); renderCharts(); renderCalc(); }
    });
  });
}

// ============ SELECTOR DE MONEDA ============
function setupMoneda() {
  document.querySelectorAll("#monedaBar .moneda-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.moneda === MONEDA);
    b.addEventListener("click", () => {
      MONEDA = b.dataset.moneda;
      localStorage.setItem("divi-moneda", MONEDA);
      document.querySelectorAll("#monedaBar .moneda-btn")
        .forEach((x) => x.classList.toggle("active", x === b));
      if (DATA) { renderNumbers(); renderCharts(); }
    });
  });
}

// ============ INIT ============
document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupRanges();
  setupAlerts();
  setupCalc();
  setupMoneda();
  setupFinde();
  setupBanco();
  $("newsRefresh").addEventListener("click", () => { loadNews(); toast("Noticias actualizadas"); });
  $("refreshBtn").addEventListener("click", () => refresh(true));
  await refresh(false);
  renderCalc();
  await loadAlerts();

  // contador de próxima actualización (tic cada segundo)
  tickCountdown();
  setInterval(tickCountdown, 1000);

  // un único handler al volver a la app: refresca datos y revisa nueva versión
  let _swCheckUpdate = null;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    refresh(false);
    if (_swCheckUpdate) _swCheckUpdate();
  });

  // service worker + aviso de nueva versión de la app
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      // ¿quedó una versión nueva ya instalada esperando? (la app estuvo cerrada)
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
      // detecta cuando se descarga una versión nueva del app shell
      reg.addEventListener("updatefound", () => {
        const nuevo = reg.installing;
        if (!nuevo) return;
        nuevo.addEventListener("statechange", () => {
          if (nuevo.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
      // la PWA abierta no revisa sola: chequea al volver a la app (handler de arriba) y cada 30 min
      _swCheckUpdate = () => reg.update().catch(() => {});
      setInterval(_swCheckUpdate, 30 * 60000);
    }).catch(() => {});
  }
});
