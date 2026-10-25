import { CONFIG as C } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, query, orderByKey, limitToLast, onChildAdded, get } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

const db = getDatabase(initializeApp({ databaseURL: C.databaseURL }));
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const set = (s, v) => { $(s).textContent = v; };
const fmt = (v, d = 2) => (v == null || isNaN(v)) ? "–" : Number(v).toLocaleString("id-ID", { minimumFractionDigits: d, maximumFractionDigits: d });
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: C.tz });
const toSec = t => t.split(":").reduce((s, v) => s * 60 + Number(v), 0);
const nowSec = () => toSec(new Date().toLocaleTimeString("en-GB", { timeZone: C.tz }));
const dlabel = d => new Date(d + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
const nn = v => (typeof v === "number" && isFinite(v)) ? v : null;
const fE = wh => [fmt(wh / 1000, 4), "kWh"];                 // energi selalu dalam kWh
const fC = g => g >= 1000 ? [fmt(g / 1000, 3), "kg"] : [fmt(g, 2), "g"];

const COL = { daya: "#f59e0b", tegangan: "#2563eb", arus: "#7c3aed", energi: "#059669" };
const M = { daya: ["Daya", "W"], tegangan: ["Tegangan", "V"], arus: ["Arus", "A"], energi: ["Energi", "kWh"] };
let metric = "daya", dayRows = [], charts = {}, curDay = null, unsub = null, avail = [], histAll = [], hs = null;

/* ---------- Data: normalisasi & agregasi ---------- */
function norm(t, r) {
  const o = { t, tegangan: nn(r.tegangan), arus: nn(r.arus), daya: nn(r.daya) };
  if (r.daya_hitung != null && o.arus != null) o.arus *= C.arusScale;   // koreksi skala arus (lihat config.js)
  return o;
}
async function loadRows(day) {
  const s = await get(query(ref(db, `${C.root}/${day}`), orderByKey()));
  const a = []; s.forEach(c => { a.push(norm(c.key, c.val() || {})); }); return a;
}
const vals = (a, k) => a.map(x => x[k]).filter(v => v != null);
const avg = (a, k) => { const v = vals(a, k); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
const mx = (a, k) => { const v = vals(a, k); return v.length ? Math.max(...v) : null; };
const mn = (a, k) => { const v = vals(a, k); return v.length ? Math.min(...v) : null; };
function summarize(rows) {
  const h = {}, g = {}; let wh = 0;
  if (rows.length) rows[0].energi = 0;                // energi = akumulasi (kWh) sejak data pertama
  for (let i = 1; i < rows.length; i++) {            // energi = integral daya terhadap waktu
    const a = rows[i - 1], b = rows[i], dt = toSec(b.t) - toSec(a.t);
    if (dt > 0 && dt <= 120 && a.daya != null && b.daya != null) { const e = (a.daya + b.daya) / 2 * dt / 3600; wh += e; h[a.t.slice(0, 2)] = (h[a.t.slice(0, 2)] || 0) + e; }
    b.energi = wh / 1000;
  }
  rows.forEach(r => (g[r.t.slice(0, 2)] ||= []).push(r));
  const pk = rows.reduce((b, x) => (x.daya != null && (b == null || x.daya > b.daya)) ? x : b, null);
  return { n: rows.length, wh, peak: pk?.daya ?? null, peakAt: pk?.t ?? "–",
    vAvg: avg(rows, "tegangan"), vMin: mn(rows, "tegangan"), vMax: mx(rows, "tegangan"), iAvg: avg(rows, "arus"), iMax: mx(rows, "arus"),
    hours: Object.keys(g).sort().map(k => ({ h: k, jam: `${k}:00–${k}:59`, n: g[k].length, v: avg(g[k], "tegangan"), i: avg(g[k], "arus"), p: avg(g[k], "daya"), pmax: mx(g[k], "daya"), e: h[k] || 0 })) };
}

/* ---------- Navigasi & jam ---------- */
const titles = { monitor: 1, grafik: 1, histori: 1 };
function show() {
  const v = titles[location.hash.slice(1)] ? location.hash.slice(1) : "monitor";
  $$(".view").forEach(s => s.hidden = s.id !== v);
  $$(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.v === v));
}
addEventListener("hashchange", show); show();

/* ---------- Chart ---------- */
const axis = () => ({ ticks: { color: "#6b7280", maxTicksLimit: 8 }, grid: { color: "#eef0f3" }, border: { display: false } });
function line(id, data, key) {
  const col = COL[key];
  if (!charts[id]) charts[id] = new Chart($("#" + id), {
    type: "line", data: { labels: [], datasets: [{ data: [], fill: true, tension: .35, pointRadius: 0, borderWidth: 2.5, spanGaps: true }] },
    options: { maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false }, plugins: { legend: { display: false } }, scales: { x: axis(), y: axis() } }
  });
  const c = charts[id], ds = c.data.datasets[0];
  c.data.labels = data.map(r => r.t); ds.data = data.map(r => r[key]);
  ds.label = `${M[key][0]} (${M[key][1]})`; ds.borderColor = col;
  ds.backgroundColor = ctx => { const a = ctx.chart.chartArea; if (!a) return "transparent";
    const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom); g.addColorStop(0, col + "44"); g.addColorStop(1, col + "00"); return g; };
  c.update("none");
}

/* ---------- Tanggal tersedia & dashboard ---------- */
async function loadAvail() {
  try { const j = await (await fetch(`${C.databaseURL}/${C.root}.json?shallow=true`)).json(); if (j && !j.error) avail = Object.keys(j).sort(); } catch {}
  if (!avail.length) {                                // cadangan: ambil tanggal terakhir lewat SDK
    try { const s = await get(query(ref(db, C.root), orderByKey(), limitToLast(1))); s.forEach(c => { avail = [c.key]; }); } catch {}
  }
}
const pickDay = () => (!avail.length || avail.includes(today())) ? today() : avail.at(-1);   // hari ini, atau tanggal terakhir yang punya data

async function subscribe(day) {
  unsub && unsub(); unsub = null; curDay = day; dayRows = []; setStatus("", "Memuat data…");
  try { dayRows = await loadRows(day); } catch (e) { return setStatus("off", "Gagal membaca: " + (e.code || e.message)); }
  if (curDay !== day) return;
  render();
  if (day !== today()) return;                        // tanggal arsip: tidak perlu mengikuti data baru
  unsub = onChildAdded(query(ref(db, `${C.root}/${day}`), orderByKey(), limitToLast(1)), s => {
    if (dayRows.length && s.key <= dayRows.at(-1).t) return;
    dayRows.push(norm(s.key, s.val() || {})); render();
  }, e => setStatus("off", "Gagal membaca: " + e.code));
}
function setStatus(cls, txt) { const e = $("#status"); e.className = "pill " + cls; e.textContent = txt; }
function status() {
  const r = dayRows.at(-1);
  if (!r) return setStatus("", "Belum ada data");
  if (curDay !== today()) return setStatus("", "Data terakhir · " + dlabel(curDay));
  const age = nowSec() - toSec(r.t);
  age <= C.offlineAfterSec ? setStatus("on", "Online") : setStatus("off", "Offline");
}
const kpi = (id, [v, u]) => { set("#" + id, v); set("#" + id + "U", u); };
function render() {
  const r = dayRows.at(-1);
  if (r) {
    const s = summarize(dayRows);
    set("#vDaya", fmt(r.daya, 1)); set("#vTegangan", fmt(r.tegangan, 2)); set("#vArus", fmt(r.arus, 3));
    set("#vWaktu", (curDay === today() ? "" : dlabel(curDay) + " · ") + r.t);
    set("#vPeak", fmt(s.peak, 2)); kpi("vEnHari", fE(s.wh));
    $("#gArc").style.strokeDashoffset = 364.4 * (1 - Math.min(1, (r.daya || 0) / C.panelWp));
  }
  status(); drawLive();
}
function drawLive() {
  if (!dayRows.length) return;
  const n = Number($("#range").value); line("bigChart", n ? dayRows.slice(-n) : dayRows, metric);
  const b = {}; dayRows.forEach(r => { if (r.daya != null) (b[Math.floor(toSec(r.t) / 300)] ||= []).push(r.daya); });
  line("dayChart", Object.keys(b).map(k => { const s = k * 300;
    return { t: `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}`, daya: b[k].reduce((x, y) => x + y, 0) / b[k].length }; }), "daya");
}
$("#metricTabs").append(...Object.keys(M).map(k => { const b = document.createElement("button"); b.textContent = M[k][0]; b.dataset.k = k;
  b.onclick = () => { metric = k; mark(); drawLive(); }; return b; }));
const mark = () => $$("#metricTabs button").forEach(b => b.classList.toggle("on", b.dataset.k === metric));
mark(); $("#range").onchange = drawLive;

let tick = 0;
setInterval(async () => {
  if (++tick % 12 === 0) { await loadAvail(); const v = $("#tgl").value; fillDates(); $("#tgl").value = v; }   // cek tanggal baru tiap ±1 menit
  const d = pickDay(); if (curDay && d !== curDay) subscribe(d);
  status();
}, 5000);

/* ---------- Histori & laporan: per minggu, data diringkas per jam ---------- */
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const weekStart = d => addDays(d, -((new Date(d + "T00:00:00Z").getUTCDay() + 6) % 7));
const dshort = d => new Date(d + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short" });
const dname = d => new Date(d + "T00:00:00").toLocaleDateString("id-ID", { weekday: "short" });
function fillDates() {
  const ws = [...new Set((avail.length ? avail : [today()]).map(weekStart))].sort().reverse();
  $("#tgl").innerHTML = ws.map(w => `<option value="${w}">${dshort(w)} – ${dlabel(addDays(w, 6))}</option>`).join("");
}
async function loadHistory() {
  const ws = $("#tgl").value; if (!ws) return; set("#info", "Memuat…");
  try {
    const all = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const days = avail.length ? all.filter(d => avail.includes(d)) : all;
    const data = await Promise.all(days.map(loadRows)), sums = data.map(summarize);
    const rows = data.flatMap((r, i) => r.map(x => ({ d: days[i], ...x })));
    const hourRows = days.flatMap((d, i) => sums[i].hours.map(x => ({ d, ...x })));   // 1 baris per jam
    const pk = rows.reduce((b, x) => (x.daya != null && (b == null || x.daya > b.daya)) ? x : b, null);
    hs = { ws, hourRows, n: rows.length, wh: sums.reduce((s, x) => s + x.wh, 0), peak: pk?.daya ?? null,
      peakAt: pk ? `${dname(pk.d)} ${dshort(pk.d)} · ${pk.t.slice(0, 5)}` : "–", vAvg: avg(rows, "tegangan"), vMin: mn(rows, "tegangan"), vMax: mx(rows, "tegangan"), iAvg: avg(rows, "arus"), iMax: mx(rows, "arus") };
    $("#rows").innerHTML = hourRows.length
      ? hourRows.map(r => `<tr><td>${dname(r.d)}, ${dshort(r.d)}</td><td>${r.h}:00</td><td>${r.n}</td><td>${fmt(r.v)}</td><td>${fmt(r.i, 3)}</td><td>${fmt(r.p)}</td><td>${fmt(r.pmax)}</td><td>${fmt(r.e / 1000, 4)}</td></tr>`).join("")
        + `<tr class="tot"><td>Total</td><td></td><td>${hs.n.toLocaleString("id-ID")}</td><td></td><td></td><td></td><td></td><td>${fmt(hs.wh / 1000, 4)}</td></tr>`
      : `<tr><td colspan="8" class="muted">Tidak ada data pada minggu ini.</td></tr>`;
    kpi("sTotal", fE(hs.wh)); set("#sPeak", fmt(hs.peak)); set("#sPeakAt", pk ? hs.peakAt : "");
    set("#sVolt", fmt(hs.vAvg)); set("#sN", hourRows.length.toLocaleString("id-ID") + " jam"); set("#info", ""); drawHour();
  } catch (e) { set("#info", "Gagal memuat: " + (e.code || e.message)); }
}
function drawHour() {
  charts.hourChart?.destroy();
  charts.hourChart = new Chart($("#hourChart"), { type: "bar",
    data: { labels: hs.hourRows.map(r => `${dname(r.d)} ${r.h}:00`), datasets: [{ label: "Energi (kWh)", data: hs.hourRows.map(r => r.e / 1000), backgroundColor: COL.energi, borderRadius: 3 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ...axis(), grid: { display: false } }, y: axis() } } });
}
$("#tgl").onchange = loadHistory;
const save = (blob, name) => { const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
const hasData = () => hs?.hourRows.length ? true : (set("#info", "Tidak ada data untuk diekspor. Pilih minggu yang memiliki data."), false);
$("#csv").onclick = () => {
  if (!hasData()) return;
  const csv = ["tanggal,jam,jumlah_data,tegangan_avg_v,arus_avg_a,daya_avg_w,daya_max_w,energi_kwh",
    ...hs.hourRows.map(r => [r.d, r.h + ":00", r.n, r.v?.toFixed(2), r.i?.toFixed(3), r.p?.toFixed(2), r.pmax?.toFixed(2), (r.e / 1000).toFixed(4)].map(v => v ?? "").join(","))].join("\n");
  save(new Blob([csv], { type: "text/csv" }), `Sunergy_Minggu_${hs.ws}.csv`);
};

/* ---------- Export Excel: Ringkasan + Per Jam ---------- */
$("#xls").onclick = async () => {
  if (!hasData()) return;
  const s = hs, wb = new ExcelJS.Workbook(); wb.creator = C.plantName; wb.created = new Date();
  const thin = { style: "thin", color: { argb: "FFCBD5E1" } }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const head = row => row.eachCell(c => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; c.border = box; });

  const w1 = wb.addWorksheet("Ringkasan"); w1.columns = [{ width: 36 }, { width: 28 }];
  w1.mergeCells("A1:B1"); w1.getCell("A1").value = `${C.plantName} – Laporan Mingguan`; w1.getCell("A1").font = { bold: true, size: 16, color: { argb: "FFB45309" } };
  w1.getCell("A2").value = "Periode"; w1.getCell("B2").value = `${dlabel(s.ws)} – ${dlabel(addDays(s.ws, 6))}`; w1.getCell("A2").font = { bold: true };
  head(w1.addRow(["Parameter", "Nilai"]));
  [["Total energi (kWh)", s.wh / 1000, "0.0000"], ["Daya puncak (W)", s.peak, "0.00"], ["Waktu daya puncak", s.peakAt, "@"],
   ["Tegangan rata-rata (V)", s.vAvg, "0.00"], ["Tegangan minimum (V)", s.vMin, "0.00"], ["Tegangan maksimum (V)", s.vMax, "0.00"],
   ["Arus rata-rata (A)", s.iAvg, "0.000"], ["Arus maksimum (A)", s.iMax, "0.000"], ["Jumlah data (pembacaan)", s.n, "#,##0"]]
    .forEach(([k, v, f]) => { const r = w1.addRow([k, v]); r.getCell(2).numFmt = f; r.getCell(2).alignment = { horizontal: "right" }; r.eachCell(c => { c.border = box; }); });

  const w2 = wb.addWorksheet("Per Jam", { views: [{ state: "frozen", ySplit: 1 }] });
  w2.columns = [{ header: "Tanggal", key: "d", width: 13 }, { header: "Jam", key: "jam", width: 8 }, { header: "Jumlah Data", key: "n", width: 12 },
    { header: "Tegangan Rata-rata (V)", key: "v", width: 20, style: { numFmt: "0.00" } }, { header: "Arus Rata-rata (A)", key: "i", width: 18, style: { numFmt: "0.000" } },
    { header: "Daya Rata-rata (W)", key: "p", width: 18, style: { numFmt: "0.00" } }, { header: "Daya Maks (W)", key: "pmax", width: 15, style: { numFmt: "0.00" } },
    { header: "Energi (kWh)", key: "e", width: 14, style: { numFmt: "0.0000" } }];
  head(w2.getRow(1)); w2.addRows(s.hourRows.map(r => ({ ...r, jam: r.h + ":00", e: r.e / 1000 })));
  const last = w2.rowCount; w2.autoFilter = { from: "A1", to: `H${last}` };
  const tot = w2.addRow({ d: "TOTAL" }); tot.getCell(3).value = { formula: `SUBTOTAL(9,C2:C${last})` }; tot.getCell(8).value = { formula: `SUBTOTAL(9,H2:H${last})` };
  tot.eachCell({ includeEmpty: true }, c => { c.font = { bold: true }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } }; });
  w2.eachRow(r => r.eachCell({ includeEmpty: true }, c => { c.border = box; }));
  save(new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `Sunergy_Laporan_Minggu_${s.ws}.xlsx`);
};

/* ---------- Mulai ---------- */
(async () => {
  await loadAvail(); fillDates();
  const d = pickDay(); $("#tgl").value = weekStart(d);
  await subscribe(d); loadHistory();
})();