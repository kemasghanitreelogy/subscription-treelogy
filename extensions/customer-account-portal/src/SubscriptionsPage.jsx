/** @jsxImportSource preact */
// PENTING: pragma di atas + jsconfig.json wajib dipertahankan. Root repo
// memuat React 18 (admin app); tanpa keduanya bundler meng-compile JSX ke
// runtime React dan Preact merender KOSONG tanpa error.
//
// Halaman penuh "Langganan" di akun pelanggan — Subscription management UI.
// Komponen Polaris s-* saja (§6.4). Aksi utama inline (skip/jeda/lanjut);
// urutan deflect §7.6: Skip paling menonjol, Batalkan hanya di portal penuh.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

const APP_URL = "https://treelogy-subscriptions.fly.dev";
const TIMEOUT_MS = 10000;

/**
 * Jangan pernah menggantung diam-diam — paksa error setelah 10 detik.
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function withTimeout(promise) {
  /** @type {Promise<never>} */
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout — coba muat ulang")), TIMEOUT_MS),
  );
  return Promise.race([promise, timeout]);
}

export default async () => {
  try {
    render(<SubscriptionsPage />, document.body);
  } catch (err) {
    console.error("[treelogy-sub] render gagal:", err);
    render(
      <s-page heading="Langganan">
        <s-section>
          <s-text>Halaman tidak bisa dimuat. Coba muat ulang.</s-text>
        </s-section>
      </s-page>,
      document.body,
    );
  }
};

function SubscriptionsPage() {
  const [state, setState] = useState({ loading: true, subs: [], error: null });
  const [notice, setNotice] = useState(null);
  const [relinkUrl, setRelinkUrl] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      // Preview editor tidak punya sesi customer — tampilkan empty state.
      if (typeof shopify === "undefined" || !shopify?.sessionToken?.get) {
        setState({ loading: false, subs: [], error: null });
        return;
      }
      const token = await withTimeout(shopify.sessionToken.get());
      const res = await withTimeout(
        fetch(`${APP_URL}/api/customer/subscriptions`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ loading: false, subs: data.subscriptions, error: null });
    } catch (err) {
      console.error("[treelogy-sub] gagal memuat:", err);
      setState({ loading: false, subs: [], error: String(err) });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Token portal sekali pakai — setelah satu aksi, muat ulang untuk token baru.
  const act = async (sub, path, extra = {}) => {
    setBusyId(sub.id);
    setNotice(null);
    try {
      const portalToken = sub.portalUrl.split("/").pop();
      const body = new URLSearchParams({ token: portalToken, ...extra });
      const res = await fetch(`${APP_URL}/api/sub/${sub.id}/${path}`, {
        method: "POST",
        body,
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.paymentUrl) {
        // Re-link: arahkan ke halaman aman Xendit lewat tombol (bukan popup).
        setRelinkUrl(data.paymentUrl);
        setNotice({ tone: "info", text: "Lanjutkan menghubungkan metode pembayaran di halaman aman:" });
      } else {
        setNotice({
          tone: "success",
          text: data.nextChargeDate ? `Beres! Tagihan berikutnya: ${data.nextChargeDate}` : "Beres!",
        });
      }
      await load();
    } catch (err) {
      setNotice({ tone: "critical", text: String(err) });
    } finally {
      setBusyId(null);
    }
  };

  if (state.loading) {
    return (
      <s-page heading="Langganan">
        <s-section>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-spinner accessibilityLabel="Memuat langganan" />
            <s-text>Memuat langganan…</s-text>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  if (state.error) {
    return (
      <s-page heading="Langganan">
        <s-banner tone="critical" heading="Gagal memuat">
          <s-text>Coba muat ulang halaman.</s-text>
        </s-banner>
      </s-page>
    );
  }

  if (!state.subs.length) {
    return (
      <s-page heading="Langganan">
        <s-section>
          <s-stack direction="block" gap="base">
            <s-heading>Belum ada langganan</s-heading>
            <s-text>
              Mulai langganan dari halaman produk — hemat di tiap pengiriman, ada pengingat 3 hari
              sebelum tagihan, dan bisa lewati, jeda, atau batal kapan saja.
            </s-text>
          </s-stack>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Langganan">
      {notice && (
        <s-banner tone={notice.tone} dismissible>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>{notice.text}</s-text>
            {relinkUrl && notice.tone === "info" && (
              <s-button variant="primary" href={relinkUrl}>Hubungkan pembayaran</s-button>
            )}
          </s-stack>
        </s-banner>
      )}
      {state.subs.map((sub) => (
        <s-section key={sub.id}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-heading>{sub.productTitle}</s-heading>
              {/* customer-account: tone badge sah hanya critical|auto|neutral */}
              <s-badge tone={sub.status === "active" ? "auto" : sub.status === "dunning" ? "critical" : "neutral"}>
                {sub.status === "active" && "Aktif"}
                {sub.status === "dunning" && "Menunggu pembayaran"}
                {sub.status === "paused" && "Dijeda"}
              </s-badge>
            </s-stack>

            <s-text>
              {sub.status === "active" && `${sub.amountLabel} · tagihan berikutnya ${sub.nextChargeDate}`}
              {sub.status === "dunning" &&
                "Pembayaran terakhir belum berhasil — kami coba lagi otomatis. Cek saldo/metode pembayaranmu."}
              {sub.status === "paused" &&
                (sub.hasPaymentMethod
                  ? "Tidak ada tagihan selama dijeda. Lanjutkan kapan saja."
                  : "Dijeda karena metode pembayaran belum terhubung. Hubungkan ulang untuk melanjutkan.")}
            </s-text>

            <s-stack direction="inline" gap="small-200">
              {sub.status === "active" && (
                <s-button variant="primary" loading={busyId === sub.id} disabled={busyId !== null} onClick={() => act(sub, "skip")}>
                  Lewati 1 siklus
                </s-button>
              )}
              {sub.status === "active" && (
                <s-button loading={busyId === sub.id} disabled={busyId !== null} onClick={() => act(sub, "pause", { mode: "pause", months: "1" })}>
                  Jeda
                </s-button>
              )}
              {sub.status === "paused" && sub.hasPaymentMethod && (
                <s-button variant="primary" loading={busyId === sub.id} disabled={busyId !== null} onClick={() => act(sub, "pause", { mode: "resume" })}>
                  Lanjutkan langganan
                </s-button>
              )}
              {sub.status === "paused" && !sub.hasPaymentMethod && (
                <s-button variant="primary" loading={busyId === sub.id} disabled={busyId !== null} onClick={() => act(sub, "relink")}>
                  Hubungkan ulang pembayaran
                </s-button>
              )}
              <s-button href={sub.portalUrl}>Kelola lengkap</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      ))}
      <s-section>
        <s-text color="subdued">
          Pengingat dikirim 3 hari sebelum setiap tagihan. Jeda/lanjut mengikuti jaminan minimal 3
          hari sebelum penagihan berikutnya.
        </s-text>
      </s-section>
    </s-page>
  );
}
