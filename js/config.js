// Konfigurasi website. Tidak ada secret di sini: website hanya MEMBACA data.
export const CONFIG = {
  plantName: "Sunergy Solar Monitoring",
  databaseURL: "https://sunergy-e94e1-default-rtdb.asia-southeast1.firebasedatabase.app",
  root: "alat1",          // path data (alat2 berisi 3 data uji saja)
  tz: "Asia/Jakarta",
  offlineAfterSec: 40,    // ESP kirim tiap ±10 detik
  panelWp: 10,            // kapasitas panel (Wp). Data Anda puncaknya ±7 W, sesuaikan dengan panel sebenarnya
  // Data yang memuat field daya_hitung (firmware terbaru) membagi arus dengan 1000, padahal
  // register arus PZEM-017 beresolusi 0,01 A, sehingga arus terbaca 10x terlalu kecil.
  // Website mengoreksinya di sini tanpa mengubah ESP. Isi 1 untuk mematikan koreksi.
  arusScale: 10,
  co2Factor: 0.87,        // g CO2 per Wh (= kg per kWh), perkiraan faktor emisi grid
  tariff: 1444.7          // Rp per kWh untuk estimasi nilai energi
};
