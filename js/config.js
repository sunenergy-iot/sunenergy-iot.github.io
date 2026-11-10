// Konfigurasi website. Tidak ada secret di sini: website hanya MEMBACA data.
export const CONFIG = {
  plantName: "Sunergy Solar Monitoring",
  databaseURL: "https://sunergy-e94e1-default-rtdb.asia-southeast1.firebasedatabase.app",
  root: "alat1",           // path data di Firebase
  tz: "Asia/Jakarta",

  offlineAfterSec: 30,     // ESP dianggap offline bila tidak ada data baru selama ini (ESP kirim tiap ±11 dtk)
  maxGapSec: 120,          // jeda data lebih dari ini tidak ikut dihitung sebagai energi/produksi
  voltOffBelow: 1,         // V. Tegangan di bawah ini = panel tidak aktif (ESP mengirim 0 V saat PZEM mati)
  producingAboveW: 0.5,    // W. Daya di atas ini dihitung sebagai "sedang produksi"
  panelWp: 10,             // kapasitas panel (Wp). Sesuaikan dengan panel sebenarnya

  // Hanya untuk data lama (firmware yang menulis field daya_hitung): arus terbaca 10x terlalu kecil.
  // Firmware terbaru tidak menulis field itu, jadi koreksi ini tidak berlaku. Isi 1 untuk mematikan.
  arusScale: 10,

  tariff: 1444.7           // Rp per kWh untuk estimasi nilai energi
};
