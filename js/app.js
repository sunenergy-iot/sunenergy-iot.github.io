import { CONFIG as C } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, query, orderByKey, limitToLast, onValue, get } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const db = getDatabase(initializeApp({ databaseURL: C.databaseURL }));

/* =====================================================================
   Util
   ===================================================================== */
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const set = (s, v) => { const e = $(s); if (e) e.textContent = v; };
const fmt = (v, d = 2) => (v == null || isNaN(v)) ? "–" : Number(v).toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
let clockOffset = 0;                                   // selisih jam server Firebase dengan jam perangkat (ms)
const nowDate = () => new Date(Date.now() + clockOffset);
const today = () => nowDate().toLocaleDateString("sv-SE", { timeZone: C.tz });
const toSec = t => t.split(":").reduce((s, v) => s * 60 + Number(v), 0);
const nowSec = () => toSec(nowDate().toLocaleTimeString("en-GB", { timeZone: C.tz, hourCycle: "h23" }));
const dlabel = d => new Date(d + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
const dshort = d => new Date(d + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short" });
const dname = d => new Date(d + "T00:00:00").toLocaleDateString("id-ID", { weekday: "short" });
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekStart = d => addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
const nn = v => (typeof v === "number" && isFinite(v)) ? v : null;
const fE = wh => wh == null ? ["–", "Wh"] : wh < 1000 ? [fmt(wh, 1), "Wh"] : [fmt(wh / 1000, 3), "kWh"];
const fDur = s => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} j ${m} m` : `${m} m`; };
const fAgo = s => s < 60 ? `${s} dtk` : s < 3600 ? `${Math.floor(s / 60)} mnt` : `${Math.floor(s / 3600)} j ${Math.floor(s % 3600 / 60)} mnt`;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), ms))]);
const notice = t => { const e = $("#msg"); e.textContent = t; e.hidden = !t; };

const COL = { daya: "#e59a00", tegangan: "#2f6fed", arus: "#8b5cf6", energi: "#0f9d6b" };
const M = { daya: ["Daya", "W", 1], tegangan: ["Tegangan", "V", 2], arus: ["Arus", "A", 3], energi: ["Energi kumulatif", "Wh", 1] };

let dayRows = [], prevRows = [], curDay = null, unsub = null, avail = [], seq = 0, loading = true, conn = null;
let dmode = "live", metric = "daya", curView = "monitor", charts = {}, hs = null, histLoaded = false, hmode = "hari", hiddenAt = 0;
const cache = new Map();                               // hari yang sudah lewat tidak perlu diunduh ulang

/* =====================================================================
   Data: normalisasi, pengambilan, ringkasan
   ===================================================================== */
function norm(t, r) {
  r = r || {};
  const o = { t, tegangan: nn(r.tegangan), arus: nn(r.arus), daya: nn(r.daya), ok: r.ok };
  if (r.daya_hitung != null && o.arus != null) o.arus *= C.arusScale;   // koreksi data lama (lihat config.js)
  return o;
}
const rowsFrom = s => { const a = []; s.forEach(c => { a.push(norm(c.key, c.val())); }); return a; };
async function loadRows(day, force) {
  if (!force && day !== today() && cache.has(day)) return cache.get(day);
  const s = await withTimeout(get(query(ref(db, `${C.root}/${day}`), orderByKey())), 30000);
  const a = rowsFrom(s);
  if (day !== today()) cache.set(day, a);
  return a;
}
const active = r => r.tegangan != null && r.tegangan >= C.voltOffBelow;
const rowState = r => r.ok === false ? "pzem_tidak_terbaca" : (r.tegangan ?? 0) < C.voltOffBelow ? "panel_tidak_aktif" : "normal";
const vals = (a, k) => a.map(x => x[k]).filter(v => v != null);
const avg = (a, k) => { const v = vals(a, k); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const mx = (a, k) => { const v = vals(a, k); return v.length ? Math.max(...v) : null; };
const mn = (a, k) => { const v = vals(a, k); return v.length ? Math.min(...v) : null; };

function summarize(rows) {
  const hr = {}, g = {}; let wh = 0, prod = 0, cover = 0;
  if (rows.length) rows[0].energi = 0;                 // energi (Wh) = integral daya terhadap waktu sejak data pertama hari itu
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i], dt = toSec(b.t) - toSec(a.t);
    if (dt > 0 && dt <= C.maxGapSec) {
      cover += dt;
      if (a.daya != null && b.daya != null) {
        const e = (a.daya + b.daya) / 2 * dt / 3600, k = a.t.slice(0, 2);
        wh += e; hr[k] = (hr[k] || 0) + e;
        if (a.daya >= C.producingAboveW) prod += dt;
      }
    }
    b.energi = wh;
  }
  rows.forEach(r => (g[r.t.slice(0, 2)] ||= []).push(r));
  const act = rows.filter(active);
  const pk = rows.reduce((b, x) => (x.daya != null && (b == null || x.daya > b.daya)) ? x : b, null);
  const span = rows.length > 1 ? toSec(rows.at(-1).t) - toSec(rows[0].t) : 0;
  return {
    n: rows.length, wh, prod, peak: pk?.daya ?? null, peakAt: pk?.t ?? "–",
    cov: span > 0 ? Math.min(100, cover / span * 100) : null,
    vAvg: avg(act, "tegangan"), vMin: mn(act, "tegangan"), vMax: mx(act, "tegangan"), iAvg: avg(act, "arus"), iMax: mx(act, "arus"),
    hours: Object.keys(g).sort().map(k => {
      const ga = g[k].filter(active);
      return { h: k, n: g[k].length, na: ga.length, v: avg(ga, "tegangan"), i: avg(ga, "arus"), p: avg(g[k], "daya"), pmax: mx(g[k], "daya"), e: hr[k] || 0 };
    })
  };
}

/* =====================================================================
   Realtime: tahan koneksi putus, tab tidur, pergantian hari
   ===================================================================== */
// Data baru masuk/berubah di Firebase -> sisipkan ke dayRows (aman untuk baris yang ditulis bertahap)
function upsert(key, val) {
  if (val == null) return false;
  const row = norm(key, val), a = dayRows;
  if (!a.length || key > a.at(-1).t) { a.push(row); return true; }
  for (let i = a.length - 1; i >= Math.max(0, a.length - 30); i--) {
    if (a[i].t === key) { a[i] = row; return true; }
    if (a[i].t < key) { a.splice(i + 1, 0, row); return true; }
  }
  return false;
}
function listen(day) {
  unsub && unsub(); unsub = null;
  unsub = onValue(query(ref(db, `${C.root}/${day}`), orderByKey(), limitToLast(3)), snap => {
    let ch = false;
    snap.forEach(c => { ch = upsert(c.key, c.val()) || ch; });   // onValue juga terpanggil saat isi baris berubah
    if (ch) { if (loading && dayRows.length) loading = false; flash(); render(); }
  }, e => notice(`Koneksi data terputus (${e.code || e.message}). Mencoba menyambung ulang…`));
}
async function pullTail(n = 30) {                      // ambil n pembacaan terakhir lewat permintaan biasa (cadangan listener)
  if (!curDay || curDay !== today() || loading) return false;
  try {
    const s = await withTimeout(get(query(ref(db, `${C.root}/${curDay}`), orderByKey(), limitToLast(n))), 10000);
    let ch = false; s.forEach(c => { ch = upsert(c.key, c.val()) || ch; });
    if (ch) { flash(); render(); }
    return ch;
  } catch { return false; }
}
const mergeRows = (a, b) => { const m = new Map(); a.forEach(r => m.set(r.t, r)); b.forEach(r => m.set(r.t, r)); return [...m.values()].sort((x, y) => x.t < y.t ? -1 : 1); };
async function loadFull(day, my) {
  try {
    const rows = await loadRows(day, true);
    if (my !== seq) return;
    dayRows = mergeRows(rows, dayRows); loading = false; notice(""); render();
    loadRows(addDays(day, -1)).then(r => { if (my === seq) { prevRows = r; drawCharts(); } }).catch(() => {});
  } catch (e) {
    if (my !== seq) return;
    if (!dayRows.length) setPill("off", "Gagal memuat");
    notice(`Gagal memuat data (${e.code || e.message}). Mencoba lagi dalam beberapa detik…`);
    setTimeout(() => { if (my === seq) loadFull(day, my); }, 8000);
  }
}
async function subscribe(day) {
  const my = ++seq; unsub && unsub(); unsub = null;
  curDay = day; dayRows = []; prevRows = []; loading = true; notice(""); setPill("", "Memuat data…");
  if (day === today()) listen(day);                    // 1) pasang pendengar realtime LEBIH DULU, tanpa menunggu unduhan apa pun
  try {                                                // 2) 30 pembacaan terakhir supaya grafik cepat terisi
    const s = await withTimeout(get(query(ref(db, `${C.root}/${day}`), orderByKey(), limitToLast(30))), 12000);
    if (my !== seq) return;
    dayRows = mergeRows(rowsFrom(s), dayRows);
    if (dayRows.length) { loading = false; render(); }
  } catch { if (my !== seq) return; }
  loadFull(day, my);                                   // 3) lalu muat seluruh hari
}

/* ---------- Status ---------- */
function setPill(cls, txt) { const e = $("#status"); e.className = "pill " + cls; e.textContent = txt; }
const latest = () => {                                 // pembacaan lengkap terakhir (abaikan baris yang baru ditulis sebagian)
  for (let i = dayRows.length - 1; i >= 0 && i > dayRows.length - 6; i--) { const r = dayRows[i]; if (r.daya != null && r.tegangan != null) return r; }
  return dayRows.at(-1) || null;
};
function tickUi() {
  const last = dayRows.at(-1);
  if (loading && !last) return;
  let cls = "", txt = "Belum ada data", ago = "";
  if (last) {
    const live = curDay === today(), age = Math.max(0, nowSec() - toSec(last.t)), r = latest();
    ago = live ? `Update terakhir ${fAgo(age)} lalu` : `Data terakhir ${dlabel(curDay)} ${last.t}`;
    if (!live) { cls = "warn"; txt = "Belum ada data hari ini"; }
    else if (conn === false) { cls = "warn"; txt = "Koneksi terputus, menyambung ulang"; }
    else if (age > C.offlineAfterSec) { cls = "off"; txt = "ESP offline"; }
    else if (r?.ok === false) { cls = "warn"; txt = "PZEM tidak terbaca"; }
    else if ((r?.tegangan ?? 0) < C.voltOffBelow) { cls = "warn"; txt = "Panel tidak aktif (0 V)"; }
    else { cls = "on"; txt = "Online"; }
  }
  setPill(cls, txt); set("#ago", ago);
}
async function loadAvail() {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try { const j = await (await fetch(`${C.databaseURL}/${C.root}.json?shallow=true`, { signal: ctl.signal })).json(); if (j && !j.error) avail = Object.keys(j).sort(); } catch {}
  clearTimeout(t);
  if (!avail.length) {                                 // cadangan: ambil tanggal terakhir lewat SDK
    try { const s = await withTimeout(get(query(ref(db, C.root), orderByKey(), limitToLast(1))), 10000); s.forEach(c => { avail = [c.key]; }); } catch {}
  }
}
const pickDay = () => (!avail.length || avail.includes(today())) ? today() : avail.at(-1);

onValue(ref(db, ".info/connected"), s => {
  const was = conn; conn = s.val() === true;
  if (conn && was === false && curDay) { pullTail(60); if (curDay === today()) listen(curDay); }
  tickUi();
});
onValue(ref(db, ".info/serverTimeOffset"), s => { clockOffset = Number(s.val()) || 0; });
document.addEventListener("visibilitychange", () => {  // tab yang tidur / HP yang terkunci sering memutus koneksi
  if (document.hidden) { hiddenAt = Date.now(); return; }
  if (!curDay) return;
  if (Date.now() - hiddenAt > 120000) loadFull(curDay, seq); else pullTail(60);
  if (curDay === today()) listen(curDay);
  tickUi();
});

setInterval(tickUi, 1000);
let beat = 0;
setInterval(async () => {                              // pemeriksaan berkala tiap 5 detik
  beat++;
  if (curDay && curDay !== today()) {                  // hari berganti, atau sedang menampilkan arsip: cek data hari ini
    if (beat % 3 === 0) { await loadAvail(); const d = pickDay(); if (d !== curDay) subscribe(d); }
  } else if (beat % 12 === 0) { await loadAvail(); refreshDates(); }
  if (!document.hidden && curDay === today()) {        // listener macet? tarik data manual
    const last = dayRows.at(-1), age = last ? nowSec() - toSec(last.t) : 999;
    if (age > 18 && await pullTail(10)) listen(curDay);
  }
}, 5000);

/* =====================================================================
   Tampilan dashboard
   ===================================================================== */
function flash() { const e = $("#liveDot"); if (!e) return; e.classList.remove("ping"); void e.offsetWidth; e.classList.add("ping"); }
const kpi = (id, [v, u]) => { set("#" + id, v); set("#" + id + "U", u); };
function render() {
  const r = latest(), s = summarize(dayRows);
  if (r) {
    set("#vDaya", fmt(r.daya, 1)); set("#vTegangan", fmt(r.tegangan, 2)); set("#vArus", fmt(r.arus, 3));
    const pct = r.daya == null ? 0 : Math.min(100, r.daya / C.panelWp * 100);
    $("#capBar").style.width = pct + "%"; set("#vCap", `${fmt(pct, 0)}% dari kapasitas ${C.panelWp} Wp`);
    set("#vWaktu", (curDay === today() ? "Pembacaan " : dlabel(curDay) + " · ") + r.t);
  }
  set("#dayTitle", curDay === today() ? "Daya hari ini" : "Daya " + dlabel(curDay));
  kpi("kEn", fE(s.wh)); set("#kPeak", fmt(s.peak, 2)); set("#kPeakAt", s.peak == null ? "" : "pukul " + s.peakAt.slice(0, 5));
  set("#kProd", fDur(s.prod)); set("#kVolt", fmt(s.vAvg, 2));
  set("#kVoltR", s.vMin == null ? "belum ada saat panel aktif" : `${fmt(s.vMin)} – ${fmt(s.vMax)} V saat aktif`);
  const rp = s.wh / 1000 * C.tariff; set("#kRp", "Rp " + fmt(rp, rp < 100 ? 1 : 0)); set("#kRpSub", `tarif Rp ${fmt(C.tariff, 0)} per kWh`);
  drawLog(); tickUi(); drawCharts();
}
const stBadge = r => { const k = rowState(r);
  return k === "normal" ? '<span class="st n" title="Normal">Normal</span>' : k === "panel_tidak_aktif" ? '<span class="st w" title="Panel tidak aktif">Panel tidak aktif</span>' : '<span class="st e" title="PZEM tidak terbaca">PZEM tidak terbaca</span>'; };
function drawLog() {
  const a = dayRows.slice(-10).reverse();
  $("#logRows").innerHTML = a.length ? a.map(r => `<tr><td>${r.t}</td><td>${fmt(r.tegangan)}</td><td>${fmt(r.arus, 3)}</td><td>${fmt(r.daya, 1)}</td><td>${stBadge(r)}</td></tr>`).join("")
    : '<tr><td colspan="5" class="muted">Belum ada data.</td></tr>';
}

/* ---------- Chart ---------- */
const axis = () => ({ ticks: { color: "#5d6b64", maxTicksLimit: innerWidth < 700 ? 5 : 8, autoSkip: true }, grid: { color: "#e8ece6" }, border: { display: false } });
function lineChart(id, labels, sets, zero = true) {
  if (typeof Chart === "undefined") return;
  let c = charts[id];
  if (!c) c = charts[id] = new Chart($("#" + id), {
    type: "line", data: { labels: [], datasets: [] },
    options: {
      maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false, align: "end", labels: { boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: { label: x => ` ${x.dataset.label}: ${fmt(x.parsed.y, x.dataset.dec ?? 2)} ${x.dataset.unit || ""}` } }
      },
      scales: { x: axis(), y: { ...axis(), beginAtZero: true } }
    }
  });
  c.options.scales.y.beginAtZero = zero;
  c.options.plugins.legend.display = sets.length > 1;
  c.data.labels = labels;
  c.data.datasets = sets.map(s => ({
    label: s.label, data: s.data, unit: s.unit, dec: s.dec, borderColor: s.color, borderWidth: s.w || 2.25, borderDash: s.dash || [],
    pointRadius: 0, tension: .3, spanGaps: false, fill: s.fill ? "origin" : false, backgroundColor: s.color + "22"
  }));
  c.update("none");
}
function curve(rows) {                                 // rata-rata daya per 5 menit, 288 titik sehari
  const b = new Array(288).fill(null), c = new Array(288).fill(0);
  rows.forEach(r => { if (r.daya == null) return; const i = Math.min(287, Math.floor(toSec(r.t) / 300)); b[i] = (b[i] || 0) + r.daya; c[i]++; });
  return b.map((v, i) => v == null ? null : v / c[i]);
}
function drawDay() {
  if (!dayRows.length) return;
  set("#dayNote", dmode === "live" ? "Pembacaan mentah 15 menit terakhir, bergerak otomatis tiap ada data baru dari alat." : "Rata-rata per 5 menit, dibandingkan dengan hari sebelumnya.");
  if (dmode === "live") {
    const last = toSec(dayRows.at(-1).t), rows = dayRows.filter(r => toSec(r.t) >= last - 900);
    return lineChart("dayChart", rows.map(r => r.t.slice(0, 8)), [{ label: "Daya", data: rows.map(r => r.daya), color: COL.daya, fill: true, unit: "W", dec: 1 }]);
  }
  const A = curve(dayRows), B = prevRows.length ? curve(prevRows) : null;
  let lo = 60, hi = 228;                               // default 05:00–19:00, melebar bila ada produksi di luar jam itu
  for (const a of [A, B]) if (a) a.forEach((v, i) => { if (v != null && v >= .2) { lo = Math.min(lo, i - 6); hi = Math.max(hi, i + 6); } });
  if (curDay === today()) hi = Math.max(hi, Math.floor(nowSec() / 300));
  lo = Math.max(0, lo); hi = Math.min(287, hi);
  const lab = []; for (let i = lo; i <= hi; i++) lab.push(`${String(Math.floor(i / 12)).padStart(2, "0")}:${String(i % 12 * 5).padStart(2, "0")}`);
  lineChart("dayChart", lab, [
    { label: curDay === today() ? "Hari ini" : dlabel(curDay), data: A.slice(lo, hi + 1), color: COL.daya, fill: true, unit: "W", dec: 1 },
    ...(B ? [{ label: "Hari sebelumnya", data: B.slice(lo, hi + 1), color: "#8a9690", dash: [5, 4], w: 1.5, unit: "W", dec: 1 }] : [])
  ]);
}

/* ---------- Grafik realtime ---------- */
function windowRows() {
  const m = Number($("#range").value);
  if (!m || !dayRows.length) return dayRows;
  const cut = toSec(dayRows.at(-1).t) - m * 60, i = dayRows.findIndex(r => toSec(r.t) >= cut);
  return dayRows.slice(Math.max(0, i));
}
function downsample(rows, max = 500) {
  if (rows.length <= max) return rows;
  const k = Math.ceil(rows.length / max), out = [];
  for (let i = 0; i < rows.length; i += k) {
    const g = rows.slice(i, i + k), o = { t: g[0].t };
    for (const key of ["tegangan", "arus", "daya", "energi"]) o[key] = avg(g, key);
    out.push(o);
  }
  return out;
}
function drawLive() {
  if (!dayRows.length) return;
  const rows = windowRows(), d = downsample(rows), [name, unit, dec] = M[metric];
  lineChart("bigChart", d.map(r => r.t), [{ label: `${name} (${unit})`, data: d.map(r => r[metric]), color: COL[metric], fill: true, unit, dec }], metric !== "tegangan");
  const base = metric === "tegangan" ? rows.filter(active) : rows, v = vals(base, metric), last = vals(rows, metric).at(-1);
  const cells = metric === "energi"
    ? [["Terakhir", last], ["Awal rentang", v[0]], ["Pertambahan", v.length ? v.at(-1) - v[0] : null]]
    : [["Terakhir", last], ["Minimum", v.length ? Math.min(...v) : null], ["Rata-rata", v.length ? v.reduce((a, b) => a + b, 0) / v.length : null], ["Maksimum", v.length ? Math.max(...v) : null]];
  $("#stats").innerHTML = cells.map(([l, x]) => `<div><span>${l}</span><b>${fmt(x, dec)} ${unit}</b></div>`).join("")
    + `<div><span>Jumlah data</span><b>${rows.length.toLocaleString("id-ID")}</b></div>`
    + (metric === "tegangan" ? '<div><span>Catatan</span><b style="font-size:.8rem;font-weight:500">min dan rata-rata hanya saat panel aktif</b></div>' : "");
}
function drawCharts() { if (curView === "monitor") drawDay(); if (curView === "grafik") drawLive(); }
$("#metricTabs").append(...Object.keys(M).map(k => { const b = document.createElement("button"); b.textContent = M[k][0]; b.dataset.k = k; b.onclick = () => { metric = k; mark(); drawLive(); }; return b; }));
const mark = () => $$("#metricTabs button").forEach(b => b.classList.toggle("on", b.dataset.k === metric));
mark(); $("#range").onchange = drawLive;
$$("#dmode button").forEach(b => b.onclick = () => { dmode = b.dataset.m; $$("#dmode button").forEach(x => x.classList.toggle("on", x === b)); drawDay(); });

/* =====================================================================
   Navigasi
   ===================================================================== */
function show() {
  const v = ["monitor", "grafik", "histori"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "monitor";
  curView = v;
  $$(".view").forEach(s => s.hidden = s.id !== v);
  $$(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
  if (v === "histori" && !histLoaded) { histLoaded = true; loadHistory(); }   // histori baru dimuat saat dibuka agar dashboard tidak terhambat
  drawCharts();
}
addEventListener("hashchange", show);

/* =====================================================================
   Histori & laporan (per minggu, diringkas per hari dan per jam)
   ===================================================================== */
function refreshDates() {
  const keep = $("#tgl").value;
  const ws = [...new Set((avail.length ? avail : [today()]).map(weekStart))].sort().reverse();
  $("#tgl").innerHTML = ws.map(w => `<option value="${w}">${dshort(w)} – ${dlabel(addDays(w, 6))}</option>`).join("");
  if (keep && ws.includes(keep)) $("#tgl").value = keep;
}
async function loadHistory() {
  const ws = $("#tgl").value; if (!ws) return; set("#info", "Memuat…");
  try {
    const all = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const days = avail.length ? all.filter(d => avail.includes(d)) : all;
    const data = await Promise.all(days.map(d => loadRows(d)));
    const sums = data.map(summarize);
    const list = days.map((d, i) => ({ d, ...sums[i] })).filter(x => x.n);
    const hourRows = list.flatMap(x => x.hours.map(h => ({ d: x.d, ...h })));
    const act = data.flat().filter(active);
    const wh = list.reduce((a, x) => a + x.wh, 0), prod = list.reduce((a, x) => a + x.prod, 0);
    const pkDay = list.reduce((b, x) => (x.peak != null && (b == null || x.peak > b.peak)) ? x : b, null);
    const best = list.reduce((b, x) => (b == null || x.wh > b.wh) ? x : b, null);
    hs = {
      ws, days: list, hourRows, wh, prod, n: list.reduce((a, x) => a + x.n, 0), best,
      data: Object.fromEntries(days.map((d, i) => [d, data[i]])),
      peak: pkDay?.peak ?? null, peakAt: pkDay ? `${dname(pkDay.d)} ${dshort(pkDay.d)} · ${pkDay.peakAt.slice(0, 5)}` : "–",
      vAvg: avg(act, "tegangan"), vMin: mn(act, "tegangan"), vMax: mx(act, "tegangan"), iAvg: avg(act, "arus"), iMax: mx(act, "arus")
    };
    $("#rawDay").innerHTML = list.map(x => `<option value="${x.d}">${dname(x.d)}, ${dshort(x.d)}</option>`).join("");
    if (list.length) $("#rawDay").value = list.at(-1).d;
    kpi("hTotal", fE(hs.wh)); set("#hAvgDay", list.length ? `rata-rata ${fE(hs.wh / list.length).join(" ")} per hari` : "");
    set("#hPeak", fmt(hs.peak)); set("#hPeakAt", pkDay ? hs.peakAt : "");
    set("#hProd", fDur(hs.prod)); set("#hBest", best ? `hari terbaik: ${dname(best.d)}, ${dshort(best.d)} (${fmt(best.wh, 1)} Wh)` : "");
    set("#hVolt", fmt(hs.vAvg)); set("#hVoltR", hs.vMin == null ? "" : `${fmt(hs.vMin)} – ${fmt(hs.vMax)} V saat aktif`);
    set("#info", ""); drawHist();
  } catch (e) { set("#info", "Gagal memuat: " + (e.code || e.message)); }
}
function drawHist() {
  if (!hs) return;
  const hide = $("#hideIdle").checked, hours = hs.hourRows.filter(h => !hide || h.na > 0 || h.e > 0);
  $("#dRows").innerHTML = hs.days.length
    ? hs.days.map(x => `<tr><td>${dname(x.d)}, ${dshort(x.d)}</td><td>${x.n.toLocaleString("id-ID")}</td><td>${fmt(x.wh, 1)}</td><td>${fmt(x.peak)}</td><td>${x.peakAt.slice(0, 5)}</td><td>${fDur(x.prod)}</td><td>${x.cov == null ? "–" : fmt(x.cov, 0) + "%"}</td></tr>`).join("")
      + `<tr class="tot"><td>Total</td><td>${hs.n.toLocaleString("id-ID")}</td><td>${fmt(hs.wh, 1)}</td><td>${fmt(hs.peak)}</td><td></td><td>${fDur(hs.prod)}</td><td></td></tr>`
    : '<tr><td colspan="7" class="muted">Tidak ada data pada minggu ini.</td></tr>';
  $("#hRows").innerHTML = hours.length
    ? hours.map(r => `<tr><td>${dname(r.d)}, ${dshort(r.d)}</td><td>${r.h}:00</td><td>${r.n}</td><td>${fmt(r.v)}</td><td>${fmt(r.i, 3)}</td><td>${fmt(r.p)}</td><td>${fmt(r.pmax)}</td><td>${fmt(r.e, 1)}</td></tr>`).join("")
    : '<tr><td colspan="8" class="muted">Tidak ada data pada minggu ini.</td></tr>';
  if (typeof Chart === "undefined") return;
  const byDay = hmode === "hari", labels = byDay ? hs.days.map(x => `${dname(x.d)} ${dshort(x.d)}`) : hours.map(r => `${dname(r.d)} ${r.h}:00`);
  charts.hourChart?.destroy();
  charts.hourChart = new Chart($("#hourChart"), {
    type: "bar",
    data: { labels, datasets: [{ label: "Energi (Wh)", data: byDay ? hs.days.map(x => x.wh) : hours.map(r => r.e), backgroundColor: COL.energi, borderRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: x => ` ${fmt(x.parsed.y, 1)} Wh` } } }, scales: { x: { ...axis(), grid: { display: false } }, y: { ...axis(), beginAtZero: true } } }
  });
}
$("#tgl").onchange = loadHistory;
const step = k => { const s = $("#tgl"), i = s.selectedIndex + k; if (i >= 0 && i < s.options.length) { s.selectedIndex = i; loadHistory(); } };
$("#prevW").onclick = () => step(1); $("#nextW").onclick = () => step(-1);
$("#hideIdle").onchange = drawHist;
$$("#hmode button").forEach(b => b.onclick = () => { hmode = b.dataset.m; $$("#hmode button").forEach(x => x.classList.toggle("on", x === b)); drawHist(); });

/* =====================================================================
   Download: CSV dan Excel
   ===================================================================== */
const save = (blob, name) => { const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const saveCsv = (lines, name) => save(new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), name);
const csvRaw = (day, rows) => ["tanggal,waktu,tegangan_v,arus_a,daya_w,energi_wh_akumulasi,kondisi",
  ...rows.map(r => [day, r.t, r.tegangan?.toFixed(2), r.arus?.toFixed(3), r.daya?.toFixed(2), r.energi?.toFixed(2), rowState(r)].map(v => v ?? "").join(","))];
const hasData = () => hs?.hourRows.length ? true : (set("#info", "Tidak ada data untuk diunduh. Pilih minggu yang memiliki data."), false);

$("#dlToday").onclick = () => {
  if (!dayRows.length) return notice("Belum ada data untuk diunduh.");
  summarize(dayRows); saveCsv(csvRaw(curDay, dayRows), `Sunergy_Data_${curDay}.csv`);
};
$("#dlView").onclick = () => {
  const rows = windowRows(); if (!rows.length) return notice("Belum ada data untuk diunduh.");
  saveCsv(csvRaw(curDay, rows), `Sunergy_Rentang_${curDay}_${rows[0].t.replaceAll(":", "")}-${rows.at(-1).t.replaceAll(":", "")}.csv`);
};
$("#raw").onclick = () => {
  const d = $("#rawDay").value, rows = hs?.data[d]; if (!rows?.length) return set("#info", "Pilih minggu yang memiliki data.");
  summarize(rows); saveCsv(csvRaw(d, rows), `Sunergy_Data_${d}.csv`);
};
$("#csv").onclick = () => {
  if (!hasData()) return;
  saveCsv(["tanggal,jam,jumlah_data,tegangan_avg_v,arus_avg_a,daya_avg_w,daya_max_w,energi_wh,energi_kwh",
    ...hs.hourRows.map(r => [r.d, r.h + ":00", r.n, r.v?.toFixed(2), r.i?.toFixed(3), r.p?.toFixed(2), r.pmax?.toFixed(2), r.e.toFixed(2), (r.e / 1000).toFixed(5)].map(v => v ?? "").join(","))],
    `Sunergy_PerJam_Minggu_${hs.ws}.csv`);
};

$("#xls").onclick = async () => {
  if (!hasData()) return;
  if (typeof ExcelJS === "undefined") return set("#info", "Library Excel belum termuat. Periksa koneksi internet lalu coba lagi.");
  const s = hs, wb = new ExcelJS.Workbook(); wb.creator = C.plantName; wb.created = new Date();
  const thin = { style: "thin", color: { argb: "FFCBD5E1" } }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const head = row => row.eachCell(c => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF16201C" } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; c.border = box; });
  const totalStyle = row => row.eachCell({ includeEmpty: true }, c => { c.font = { bold: true }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } }; });

  // 1) Ringkasan
  const w1 = wb.addWorksheet("Ringkasan"); w1.columns = [{ width: 38 }, { width: 30 }];
  w1.mergeCells("A1:B1"); w1.getCell("A1").value = `${C.plantName} – Laporan Mingguan`; w1.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFB45309" } };
  w1.getCell("A2").value = "Periode"; w1.getCell("B2").value = `${dlabel(s.ws)} – ${dlabel(addDays(s.ws, 6))}`; w1.getCell("A2").font = { bold: true };
  head(w1.addRow(["Parameter", "Nilai"]));
  [["Total energi (Wh)", s.wh, "0.0"], ["Total energi (kWh)", s.wh / 1000, "0.0000"], ["Daya puncak (W)", s.peak, "0.00"], ["Waktu daya puncak", s.peakAt, "@"],
   ["Durasi produksi (jam)", s.prod / 3600, "0.00"], ["Tegangan rata-rata saat aktif (V)", s.vAvg, "0.00"], ["Tegangan minimum saat aktif (V)", s.vMin, "0.00"], ["Tegangan maksimum (V)", s.vMax, "0.00"],
   ["Arus rata-rata saat aktif (A)", s.iAvg, "0.000"], ["Arus maksimum (A)", s.iMax, "0.000"], ["Jumlah pembacaan", s.n, "#,##0"],
   ["Estimasi nilai energi (Rp)", s.wh / 1000 * C.tariff, "#,##0.0"]]
    .forEach(([k, v, f]) => { const r = w1.addRow([k, v]); r.getCell(2).numFmt = f; r.getCell(2).alignment = { horizontal: "right" }; r.eachCell(c => { c.border = box; }); });

  // 2) Per Hari
  const w2 = wb.addWorksheet("Per Hari", { views: [{ state: "frozen", ySplit: 1 }] });
  w2.columns = [{ header: "Tanggal", key: "d", width: 14 }, { header: "Jumlah Data", key: "n", width: 13, style: { numFmt: "#,##0" } },
    { header: "Energi (Wh)", key: "wh", width: 14, style: { numFmt: "0.0" } }, { header: "Energi (kWh)", key: "kwh", width: 14, style: { numFmt: "0.0000" } },
    { header: "Daya Maks (W)", key: "peak", width: 15, style: { numFmt: "0.00" } }, { header: "Jam Puncak", key: "at", width: 12 },
    { header: "Durasi Produksi (jam)", key: "prod", width: 20, style: { numFmt: "0.00" } }, { header: "Kontinuitas Data (%)", key: "cov", width: 20, style: { numFmt: "0.0" } }];
  head(w2.getRow(1));
  w2.addRows(s.days.map(x => ({ d: x.d, n: x.n, wh: x.wh, kwh: x.wh / 1000, peak: x.peak, at: x.peakAt.slice(0, 5), prod: x.prod / 3600, cov: x.cov })));
  const l2 = w2.rowCount, t2 = w2.addRow({ d: "TOTAL" });
  [2, 3, 4, 7].forEach(c => { const L = "ABCDEFGH"[c - 1]; t2.getCell(c).value = { formula: `SUM(${L}2:${L}${l2})` }; });
  totalStyle(t2); w2.eachRow(r => r.eachCell({ includeEmpty: true }, c => { c.border = box; }));

  // 3) Per Jam
  const w3 = wb.addWorksheet("Per Jam", { views: [{ state: "frozen", ySplit: 1 }] });
  w3.columns = [{ header: "Tanggal", key: "d", width: 13 }, { header: "Jam", key: "jam", width: 8 }, { header: "Jumlah Data", key: "n", width: 12 },
    { header: "Tegangan Rata-rata (V)", key: "v", width: 20, style: { numFmt: "0.00" } }, { header: "Arus Rata-rata (A)", key: "i", width: 18, style: { numFmt: "0.000" } },
    { header: "Daya Rata-rata (W)", key: "p", width: 18, style: { numFmt: "0.00" } }, { header: "Daya Maks (W)", key: "pmax", width: 15, style: { numFmt: "0.00" } },
    { header: "Energi (Wh)", key: "wh", width: 13, style: { numFmt: "0.00" } }, { header: "Energi (kWh)", key: "kwh", width: 14, style: { numFmt: "0.00000" } }];
  head(w3.getRow(1));
  w3.addRows(s.hourRows.map(r => ({ d: r.d, jam: r.h + ":00", n: r.n, v: r.v, i: r.i, p: r.p, pmax: r.pmax, wh: r.e, kwh: r.e / 1000 })));
  const l3 = w3.rowCount; w3.autoFilter = { from: "A1", to: `I${l3}` };
  const t3 = w3.addRow({ d: "TOTAL" });
  [3, 8, 9].forEach(c => { const L = "ABCDEFGHI"[c - 1]; t3.getCell(c).value = { formula: `SUBTOTAL(9,${L}2:${L}${l3})` }; });
  totalStyle(t3); w3.eachRow(r => r.eachCell({ includeEmpty: true }, c => { c.border = box; }));

  save(new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `Sunergy_Laporan_Minggu_${s.ws}.xlsx`);
};

/* =====================================================================
   Mulai
   ===================================================================== */
(async () => {
  show();
  await loadAvail(); refreshDates();                  // loadAvail punya batas waktu, jadi tidak bisa menggantung
  const d = pickDay(); $("#tgl").value = weekStart(d);
  subscribe(d);
})();
