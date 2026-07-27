// Pelanggan menutup/membatalkan sesi pembayaran Xendit. Tidak ada dana ditarik;
// baris pending dibersihkan job cleanup-abandoned setelah 1 jam (§7.1).
export default function SubscribeCancelled() {
  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui", padding: "0 1rem", textAlign: "center" }}>
      <h1>Pembayaran dibatalkan</h1>
      <p>Tidak ada dana yang ditarik. Kamu bisa mencoba lagi kapan saja dari halaman produk.</p>
    </main>
  );
}
