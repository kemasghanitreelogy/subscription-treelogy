// Portal self-service (F5). Deep-link dari WA bisa Skip/Pause TANPA login —
// token di URL adalah otorisasinya (sekali pakai, 15 menit, scope terbatas).
// Urutan aksi = urutan deflect §7.6: Skip → Pause → Frekuensi → … → Batalkan.
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { pooledDb } from "../db/client.server";
import { consumePortalToken } from "../services/portal-token.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const db = pooledDb();
  // Loader hanya MELIHAT (consume: false) — token hangus saat aksi mutasi.
  const grant = await consumePortalToken(db, params.token!, "skip", { consume: false })
    ?? await consumePortalToken(db, params.token!, "pause", { consume: false })
    ?? await consumePortalToken(db, params.token!, "relink", { consume: false });
  if (!grant) {
    return { expired: true as const };
  }
  const { rows } = await db.query(
    `select id, status, variant_gid, quantity, unit_amount_idr, shipping_amount_idr,
            frequency_days, next_charge_date, payment_method, cycle_count
       from subscriptions where id = $1`,
    [grant.subscriptionId],
  );
  return {
    expired: false as const,
    scope: grant.scope,
    token: params.token!,
    sub: rows[0],
  };
};

const rupiah = (n: number) => `Rp${Number(n).toLocaleString("id-ID")}`;

export default function Portal() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok?: boolean; error?: string; nextChargeDate?: string; paymentUrl?: string }>();

  if (data.expired) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
        <h1>Link kedaluwarsa</h1>
        <p>Link ini sudah terpakai atau lewat 15 menit. Minta link baru lewat email/WA kamu.</p>
        <form method="post" action="/api/portal/request">
          <input type="email" name="email" placeholder="Email kamu" required style={{ padding: 8, width: "70%" }} />
          <button type="submit" style={{ padding: 8 }}>Kirim link</button>
        </form>
      </main>
    );
  }

  const { sub, token, scope } = data;
  const total = sub.unit_amount_idr * sub.quantity + sub.shipping_amount_idr;
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  if (result?.paymentUrl) {
    window.location.href = result.paymentUrl;
  }

  const act = (path: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("token", token);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fetcher.submit(fd, { method: "post", action: `/api/sub/${sub.id}/${path}` });
  };

  return (
    <main style={{ maxWidth: 480, margin: "2rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
      <h1>Langganan Treelogy</h1>
      <p>
        Status: <b>{sub.status}</b> · {rupiah(total)} tiap {sub.frequency_days} hari
        {sub.next_charge_date && <> · tagihan berikutnya <b>{sub.next_charge_date}</b></>}
      </p>

      {result?.ok && (
        <p style={{ background: "#e6f4ea", padding: 12 }}>
          Beres!{result.nextChargeDate && <> Tagihan berikutnya: <b>{result.nextChargeDate}</b>.</>} Link ini sudah
          hangus — minta link baru kalau perlu aksi lain.
        </p>
      )}
      {result?.error && <p style={{ background: "#fce8e6", padding: 12 }}>{result.error}</p>}

      {!result?.ok && (
        <div style={{ display: "grid", gap: 8 }}>
          {sub.status === "active" && (scope === "skip" || scope === "full") && (
            <button disabled={busy} onClick={() => act("skip")} style={{ padding: 12, fontWeight: 700 }}>
              Lewati 1 siklus (paling populer)
            </button>
          )}
          {sub.status === "active" && (scope === "pause" || scope === "full") && (
            <button disabled={busy} onClick={() => act("pause", { mode: "pause", months: "1" })} style={{ padding: 12 }}>
              Jeda 1 bulan
            </button>
          )}
          {sub.status === "paused" && (scope === "pause" || scope === "full") && (
            <button disabled={busy} onClick={() => act("pause", { mode: "resume" })} style={{ padding: 12 }}>
              Lanjutkan langganan (tagihan pertama minimal 3 hari lagi)
            </button>
          )}
          {scope === "full" && sub.status === "active" && (
            <>
              <button disabled={busy} onClick={() => act("frequency", { frequencyDays: "60" })} style={{ padding: 12 }}>
                Ubah jadi tiap 60 hari
              </button>
              <button disabled={busy} onClick={() => act("frequency", { frequencyDays: "90" })} style={{ padding: 12 }}>
                Ubah jadi tiap 90 hari
              </button>
            </>
          )}
          {(scope === "relink" || scope === "full") && (
            <button disabled={busy} onClick={() => act("relink")} style={{ padding: 12 }}>
              Hubungkan ulang metode pembayaran
            </button>
          )}
          {scope === "full" && sub.status !== "cancelled" && (
            <details>
              <summary style={{ padding: 12, cursor: "pointer" }}>Batalkan langganan</summary>
              <p>Sebelum batal — mau jeda dulu saja? Gratis, bisa lanjut kapan pun.</p>
              <select id="cancel-reason" style={{ padding: 8, width: "100%" }}>
                <option value="too_much">Produk masih banyak</option>
                <option value="price">Harga</option>
                <option value="not_working">Kurang cocok</option>
                <option value="other">Lainnya</option>
              </select>
              <button
                disabled={busy}
                onClick={() =>
                  act("cancel", {
                    reason: (document.getElementById("cancel-reason") as HTMLSelectElement).value,
                  })
                }
                style={{ padding: 12, marginTop: 8 }}
              >
                Ya, batalkan
              </button>
            </details>
          )}
        </div>
      )}
    </main>
  );
}
