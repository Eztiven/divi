/* Divi - logica de la PWA
 * Lee el historial de tasas, calcula el % de ahorro y dibuja las graficas.
 */

// ============ CONFIG ============
// Si NO despliegas con cada actualizacion del cron, pega aqui la URL "raw" de tu
// history.json en GitHub para que la app lea los datos frescos directo del repo.
// Ej: "https://raw.githubusercontent.com/TU_USUARIO/divi/main/public/data/history.json"
// Dejalo en "" si el cron despliega a Firebase en cada corrida (entonces usa el archivo local).
const REMOTE_DATA_URL = "https://raw.githubusercontent.com/bxtiven/divi/main/public/data/history.json";
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
let MONEDA = localStorage.getItem("divi-moneda") || "usdt";   // 'usdt' | 'euro' | 'ambos'
const ASSETS = {
  usdt: { bcvKey: "bcv", mktKey: "ves_venta", bcvLabel: "Dólar BCV", mktLabel: "Dólar USDT", unit: "USDT", sym: "$", nombre: "USDT", color: "#2dd4bf", bcvColor: "#ffc857" },
  euro: { bcvKey: "eur_bcv", mktKey: "eur_paralelo", bcvLabel: "Euro BCV", mktLabel: "Euro paralelo", unit: "€ par", sym: "€", nombre: "Euro", color: "#a78bfa", bcvColor: "#f0abfc" },
};
const showU = () => MONEDA === "usdt" || MONEDA === "ambos";
const showE = () => MONEDA === "euro" || MONEDA === "ambos";
const primaryAsset = () => (MONEDA === "euro" ? ASSETS.euro : ASSETS.usdt);
const selectedAssets = () => (MONEDA === "ambos" ? ["usdt", "euro"] : [MONEDA]);
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
  if (MODO_FINDE === "viernes" || !h.length) { EFF = h.slice(); return; }
  EFF = new Array(h.length);
  const lastBiz = { bcv: null, eur_bcv: null };
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

  // ---- Bolívar (según la moneda seleccionada) ----
  const prim = primaryAsset();
  const pBcv = last[prim.bcvKey], pMkt = last[prim.mktKey];
  const pct = ahorroPct(pBcv, pMkt);
  $("ahorroPct").textContent = pct == null ? "--%" : `${fmt(pct)}%`;
  $("heroLabel").textContent = `Te ahorras comprando al BCV vs ${prim.nombre}`;
  if (pBcv && pMkt) {
    $("ahorroDetalle").textContent =
      `${prim.bcvLabel} ${fmt(pBcv)} · ${prim.mktLabel} ${fmt(pMkt)} → ahorras Bs ${fmt(pMkt - pBcv)}`;
  }
  // tarjetas USDT
  $("bcvValue").textContent = fmt(last.bcv);
  $("vesVentaValue").textContent = fmt(last.ves_venta);
  $("vesCompraValue").textContent = fmt(last.ves_compra);
  // tarjetas Euro
  $("eurBcvValue").textContent = fmt(last.eur_bcv);
  $("eurParValue").textContent = fmt(last.eur_paralelo);
  // mostrar/ocultar según selección
  $("cardsUsd").hidden = !showU();
  $("cardsEur").hidden = !showE();
  // aviso de fin de semana
  const wn = $("weekendNote");
  if (esFinDeSemana()) {
    wn.hidden = false;
    wn.textContent = "📅 Fin de semana: el BCV no cambia sáb/dom — la tasa que aplica es la del lunes. El USDT/Euro sí siguen moviéndose.";
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
  $("updatedAt").textContent = formatStamp(DATA.updatedAt || last.t);
}

// ============ SEMÁFORO: ¿buen día para comprar? ============
function renderSemaforo() {
  const card = $("semaforoCard");
  const dotVerdict = $("semVerdict");
  const detail = $("semDetail");
  const prim = primaryAsset();
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
  const data = rangeData("bolivar");
  const days = labelDays("bolivar", data);
  const labels = data.map((r) => labelFor(r.t, days));
  const assets = selectedAssets();
  const ds = [];
  assets.forEach((k) => {
    const a = ASSETS[k];
    ds.push({
      label: a.mktLabel, data: data.map((r) => r[a.mktKey]),
      borderColor: a.color, backgroundColor: hexA(a.color, 0.12),
      fill: assets.length === 1, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 2,
    });
    ds.push({
      label: a.bcvLabel, data: data.map((r) => r[a.bcvKey]),
      borderColor: a.bcvColor, backgroundColor: "transparent",
      fill: false, tension: 0.3, pointRadius: 0, borderWidth: 2, borderDash: [5, 4], _frac: 2,
    });
  });
  // tooltip enriquecido: muestra el equivalente en USDT/€ y la diferencia
  const opts = {
    ...chartBase,
    plugins: {
      ...chartBase.plugins,
      tooltip: {
        ...chartBase.plugins.tooltip,
        callbacks: {
          ...chartBase.plugins.tooltip.callbacks,
          afterBody: (items) => {
            const r = data[items[0].dataIndex];
            if (!r) return "";
            const lines = [];
            assets.forEach((k) => {
              const a = ASSETS[k];
              const bv = r[a.bcvKey], mk = r[a.mktKey];
              if (bv && mk) {
                const val = bv / mk, dif = mk - bv, pct = (dif / mk) * 100;
                lines.push("", `${a.sym}1 BCV = ${fmt(val, 3)} ${a.unit}`, `Dif: ${fmt(dif)} Bs (${fmt(pct)}%)`);
              }
            });
            return lines;
          },
        },
      },
    },
  };
  const title = MONEDA === "euro" ? "💶 Euro BCV vs Euro paralelo (en Bs)"
    : MONEDA === "ambos" ? "💱 Dólar y Euro · BCV vs mercado (Bs)"
    : "💵 Dólar BCV vs Dólar USDT (en Bs)";
  const t = $("bolivarChartTitle"); if (t) t.textContent = title;
  const cfg = { type: "line", data: { labels, datasets: ds }, options: opts };
  charts.bolivar?.destroy();
  charts.bolivar = new Chart($("bolivarChart"), cfg);
}

function renderPesoChart() {
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
  const data = rangeData("dolarbcv");
  const days = labelDays("dolarbcv", data);
  const labels = data.map((r) => labelFor(r.t, days));
  const assets = selectedAssets();
  const ds = assets.map((k) => {
    const a = ASSETS[k];
    return {
      label: `${a.sym}1 BCV en ${a.unit}`,
      data: data.map((r) => (r[a.bcvKey] && r[a.mktKey]) ? r[a.bcvKey] / r[a.mktKey] : null),
      borderColor: a.color, backgroundColor: hexA(a.color, 0.14),
      fill: assets.length === 1, tension: 0.3, pointRadius: 0, borderWidth: 2, _frac: 3,
    };
  });
  const title = MONEDA === "euro" ? "🪙 Valor del euro BCV en € paralelo"
    : MONEDA === "ambos" ? "🪙 Valor del BCV en el mercado"
    : "🪙 Valor del dólar BCV en USDT";
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
function setupTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`tab-${btn.dataset.tab}`).classList.add("active");
      // redibuja para que Chart.js calcule bien el tamaño al hacerse visible
      if (btn.dataset.tab === "peso") renderPesoChart();
      else if (btn.dataset.tab === "alertas") loadAlerts();
      else if (btn.dataset.tab === "calc") renderCalc();
      else if (btn.dataset.tab === "noticias") loadNews();
      else { renderBolivarChart(); renderAhorroChart(); renderDolarChart(); }
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
        customRange[target] = {
          from: from.value ? new Date(from.value + "T00:00:00").getTime() : null,
          to: to.value ? new Date(to.value + "T23:59:59").getTime() : null,
        };
        ranges[target] = "custom";
        renderTarget(target);
      };
      from.addEventListener("change", onChange);
      to.addEventListener("change", onChange);
    }
  });
}

async function refresh(showToast = true) {
  const btn = $("refreshBtn");
  btn.classList.add("spin");
  const ok = await loadData();
  if (ok) {
    computeEffective();
    renderNumbers();
    renderCharts();
    if (showToast) toast("Datos actualizados");
  } else {
    toast("No se pudieron cargar los datos");
  }
  btn.classList.remove("spin");
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
         <div class="ai-title">${m.label} ${op} ${fmt(a.value, m.frac)} ${m.unit}</div>
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
    window.open(url, "_blank");
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
const calcNum = (s) => parseFloat(String(s).replace(",", ".")) || 0;
const round2 = (n) => Number(n.toFixed(2));
const calcRow = (label, value, unit, frac = 2) =>
  `<div class="calc-row"><span class="cr-label">${label}</span>` +
  `<span class="cr-value">${fmt(value, frac)}<small>${unit}</small></span></div>`;

// source = "usd" | "bs" | "cop": casilla que el usuario editó (no se reescribe).
// La casilla de bolívares usa la tasa BCV (es el valor oficial del dólar).
function recalc(source) {
  if (_calcLock || !DATA) return;
  const h = effHistory();
  const last = h[h.length - 1];
  const bcv = last.bcv, ves = last.ves_venta, cop = last.cop_venta;

  // todo se convierte pasando por dólares (USD)
  let usd = 0;
  if (source === "usd") usd = calcNum($("calcUsd").value);
  else if (source === "bs") usd = bcv ? calcNum($("calcBs").value) / bcv : 0;   // Bs ↔ BCV
  else if (source === "cop") usd = cop ? calcNum($("calcCop").value) / cop : 0;  // COP ↔ Binance

  _calcLock = true;
  if (source !== "usd") $("calcUsd").value = usd ? round2(usd) : "";
  if (source !== "bs")  $("calcBs").value  = (usd && bcv) ? round2(usd * bcv) : "";
  if (source !== "cop") $("calcCop").value = (usd && cop) ? Math.round(usd * cop) : "";
  _calcLock = false;

  const ref = $("calcRef");
  if (!usd) { ref.innerHTML = '<p class="muted small">Escribe un monto arriba 👆</p>'; return; }

  const bsBcv = usd * bcv;               // lo que cuestan al BCV
  const usdtEnBinance = ves ? bsBcv / ves : 0;   // esos Bs convertidos a USDT en Binance
  const pct = ves ? ((ves - bcv) / ves) * 100 : 0;

  let rows = "";
  if (ves) rows += calcRow(`🔄 Esos ${fmt(bsBcv)} Bs en Binance`, usdtEnBinance, "USDT");
  if (ves) rows += calcRow("🟡 Comprar esa cantidad en Binance cuesta", usd * ves, "Bs");
  if (ves) rows += calcRow("💰 Ahorro comprando al BCV", pct, "%");
  rows += `<p class="muted small">Binance (USDT): ${fmt(ves)} Bs · BCV: ${fmt(bcv)} Bs por dólar</p>`;
  ref.innerHTML = rows;
}

function renderCalc() { recalc("usd"); }   // refresco al abrir la pestaña / cargar datos

function setupCalc() {
  $("calcUsd").addEventListener("input", () => recalc("usd"));
  $("calcBs").addEventListener("input", () => recalc("bs"));
  $("calcCop").addEventListener("input", () => recalc("cop"));
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
  $("newsRefresh").addEventListener("click", () => { loadNews(); toast("Noticias actualizadas"); });
  $("refreshBtn").addEventListener("click", () => refresh(true));
  await refresh(false);
  renderCalc();
  await loadAlerts();

  // refresca al volver a la app
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh(false);
  });

  // service worker
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
