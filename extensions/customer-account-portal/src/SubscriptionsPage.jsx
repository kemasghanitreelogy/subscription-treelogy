// Halaman penuh "Langganan" di akun pelanggan — Subscription management UI.
// Komponen Polaris s-* saja (§6.4). Aksi utama INLINE (skip/jeda/lanjut) tanpa
// pindah halaman; urutan deflect §7.6: Skip paling menonjol, Batalkan hanya
// lewat portal penuh.
import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useCallback, useEffect, useState } from "preact/hooks";

const APP_URL = "https://treelogy-subscriptions.fly.dev";

/**
 * Jangan pernah menggantung diam-diam — paksa error setelah 10 detik.
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function withTimeout(promise) {
  /** @type {Promise<never>} */
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Timeout 10 detik — coba muat ulang")), 10000),
  );
  return Promise.race([promise, timeout]);
}

console.log("[treelogy-sub] modul dievaluasi (v11)");

// Probe bedah: log di sekeliling SETIAP langkah supaya titik gagal terlihat.
export default async () => {
  try {
    console.log(
      "[treelogy-sub] fase1: typeof document =", typeof document,
      "| body ada =", typeof document !== "undefined" && Boolean(document.body),
    );
    render(
      <s-page heading="Langganan">
        <s-section>
          <s-text>Menyiapkan… (v11)</s-text>
        </s-section>
      </s-page>,
      document.body,
    );
    console.log("[treelogy-sub] fase1 render SELESAI — body children:",
      document.body?.children?.length);
    setTimeout(() => {
      console.log("[treelogy-sub] fase2 mulai");
      try {
        render(<SubscriptionsPage />, document.body);
        console.log("[treelogy-sub] fase2 render SELESAI");
      } catch (err) {
        console.error("[treelogy-sub] fase2 ERROR:", err);
      }
    }, 300);
  } catch (err) {
    console.error("[treelogy-sub] fase1 ERROR:", err);
  }
};

function SubscriptionsPage() {
  const [state, setState] = useState({ loading: true, subs: [], error: null });
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    console.log("[treelogy-sub] mulai memuat");
    try {
      // Di preview editor tidak ada sesi customer — jangan sampai melempar keras.
      if (typeof shopify === "undefined" || !shopify?.sessionToken?.get) {
        console.log("[treelogy-sub] shopify.sessionToken tidak tersedia (preview?)");
        setState({ loading: false, subs: [], error: null });
        return;
      }
      const token = await withTimeout(shopify.sessionToken.get());
      console.log("[treelogy-sub] token ok, fetch API…");
      const res = await withTimeout(
        fetch(`${APP_URL}/api/customer/subscriptions`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      console.log("[treelogy-sub] fetch status", res.status);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState({ loading: false, subs: data.subscriptions, error: null });
    } catch (err) {
      console.error("[treelogy-sub] gagal:", err);
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
      setNotice({
        tone: "success",
        text: data.nextChargeDate
          ? `Beres! Tagihan berikutnya: ${data.nextChargeDate}`
          : "Beres!",
      });
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
          <s-text>Coba muat ulang halaman. ({state.error})</s-text>
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
          <s-text>{notice.text}</s-text>
        </s-banner>
      )}
      {state.subs.map((sub) => (
        <s-section key={sub.id}>
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-heading>{sub.productTitle}</s-heading>
              {/* 2025-10: tone badge sah hanya critical|auto|neutral (bukan success/warning) */}
              <s-badge
                tone={
                  sub.status === "active"
                    ? "auto"
                    : sub.status === "dunning"
                      ? "critical"
                      : "neutral"
                }
              >
                {sub.status === "active" && "Aktif"}
                {sub.status === "dunning" && "Menunggu pembayaran"}
                {sub.status === "paused" && "Dijeda"}
              </s-badge>
            </s-stack>

            <s-text>
              {sub.status === "active" &&
                `${sub.amountLabel} · tagihan berikutnya ${sub.nextChargeDate}`}
              {sub.status === "dunning" &&
                "Pembayaran terakhir belum berhasil — kami coba lagi otomatis. Cek saldo/metode pembayaranmu."}
              {sub.status === "paused" && "Tidak ada tagihan selama dijeda. Lanjutkan kapan saja."}
            </s-text>

            <s-stack direction="inline" gap="small-200">
              {sub.status === "active" && (
                <s-button
                  variant="primary"
                  loading={busyId === sub.id}
                  disabled={busyId !== null}
                  onClick={() => act(sub, "skip")}
                >
                  Lewati 1 siklus
                </s-button>
              )}
              {sub.status === "active" && (
                <s-button
                  loading={busyId === sub.id}
                  disabled={busyId !== null}
                  onClick={() => act(sub, "pause", { mode: "pause", months: "1" })}
                >
                  Jeda
                </s-button>
              )}
              {sub.status === "paused" && (
                <s-button
                  variant="primary"
                  loading={busyId === sub.id}
                  disabled={busyId !== null}
                  onClick={() => act(sub, "pause", { mode: "resume" })}
                >
                  Lanjutkan langganan
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
