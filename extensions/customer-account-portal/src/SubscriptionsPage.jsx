// Halaman penuh "Langganan" di akun pelanggan. Komponen Polaris s-* saja —
// tidak ada HTML/CSS bebas (§6.4). Jangan kejar kesamaan visual dengan tema;
// kejar kejelasan aksi: Skip paling menonjol (urutan deflect §7.6).
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

export default async () => {
  render(<SubscriptionsPage />, document.body);
};

function SubscriptionsPage() {
  const [state, setState] = useState({ loading: true, subs: [], error: null });

  useEffect(() => {
    (async () => {
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${APP_URL}/api/customer/subscriptions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setState({ loading: false, subs: data.subscriptions, error: null });
      } catch (err) {
        setState({ loading: false, subs: [], error: String(err) });
      }
    })();
  }, []);

  if (state.loading) {
    return (
      <s-page heading="Langganan">
        <s-section>
          <s-spinner accessibilityLabel="Memuat langganan" />
        </s-section>
      </s-page>
    );
  }

  if (state.error) {
    return (
      <s-page heading="Langganan">
        <s-banner tone="critical" heading="Gagal memuat">
          <s-text>Coba muat ulang halaman. ({state.error})</s-text>
        </s-banner>
      </s-page>
    );
  }

  if (!state.subs.length) {
    return (
      <s-page heading="Langganan">
        <s-section>
          <s-heading>Belum ada langganan</s-heading>
          <s-text>Mulai langganan dari halaman produk untuk hemat dan bebas repot.</s-text>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Langganan">
      {state.subs.map((sub) => (
        <s-section key={sub.id}>
          <s-stack direction="block" gap="base">
            <s-heading>{sub.productTitle}</s-heading>
            <s-text>
              {sub.status === "active" && `Aktif — tagihan berikutnya ${sub.nextChargeDate} (tiap ${sub.frequencyDays} hari)`}
              {sub.status === "dunning" && "Pembayaran terakhir belum berhasil — kami coba lagi otomatis"}
              {sub.status === "paused" && "Dijeda"}
              {sub.status === "cancelled" && "Dibatalkan"}
            </s-text>
            <s-text>{sub.amountLabel} / siklus</s-text>
            <s-stack direction="inline" gap="small-200">
              {/* Urutan deflect: Skip paling menonjol */}
              {sub.status === "active" && (
                <s-button variant="primary" href={sub.portalUrl}>
                  Lewati 1 siklus
                </s-button>
              )}
              {sub.status === "paused" && (
                <s-button variant="primary" href={sub.portalUrl}>
                  Lanjutkan langganan
                </s-button>
              )}
              <s-button href={sub.portalUrl}>Kelola</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ))}
    </s-page>
  );
}

// Diganti saat build oleh define di CLI? Tidak — sederhana: URL app produksi.
// Setelah SHOPIFY_APP_URL final, samakan nilai ini (satu-satunya konfigurasi).
const APP_URL = "https://sub.treelogy.com";
