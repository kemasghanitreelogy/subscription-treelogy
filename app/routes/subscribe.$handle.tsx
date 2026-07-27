// Fase 2b — halaman subscribe express-flow 1 produk (F1). Consent TIDAK
// pre-ticked 🔒, copy "tiap 30 hari" (ADR-03), harga dari server.
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { getProductByHandle } from "../services/shopify-order.server";
import { getSettings } from "../services/settings.server";
import { pooledDb } from "../db/client.server";
import { assertSubscribeAccess } from "../services/launch-gate.server";

const CONSENT_TEXT =
  "Saya menyetujui pendebetan otomatis sesuai frekuensi yang saya pilih sampai saya menghentikannya. " +
  "Pengingat dikirim 3 hari sebelum setiap tagihan. Saya bisa lewati, jeda, atau batalkan kapan saja lewat link di email/WA.";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const previewKey = assertSubscribeAccess(request); // pra-launch: 404 untuk publik
  const product = await getProductByHandle(params.handle!);
  if (!product) throw new Response("Produk tidak ditemukan", { status: 404 });
  const settings = await getSettings(pooledDb());
  return { product, plans: settings.plans.filter((p) => p.enabled), previewKey };
};

const rupiah = (n: number) => `Rp${Number(n).toLocaleString("id-ID")}`;

export default function Subscribe() {
  const { product, plans, previewKey } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ paymentUrl?: string; error?: string }>();
  const variants = product.variants.edges.map((e: { node: { id: string; title: string; price: string; availableForSale: boolean } }) => e.node);

  if (fetcher.data?.paymentUrl) {
    window.location.href = fetcher.data.paymentUrl;
  }

  return (
    <main style={{ maxWidth: 520, margin: "2rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
      <h1>Langganan {product.title}</h1>
      <fetcher.Form method="post" action="/api/sub/create" style={{ display: "grid", gap: 12 }}>
        <input type="hidden" name="consentText" value={CONSENT_TEXT} />
        {previewKey && <input type="hidden" name="previewKey" value={previewKey} />}

        <label>
          Varian
          <select name="variantGid" required style={{ display: "block", padding: 8, width: "100%" }}>
            {variants.filter((v: { availableForSale: boolean }) => v.availableForSale).map((v: { id: string; title: string; price: string }) => (
              <option key={v.id} value={v.id}>
                {v.title} — {rupiah(Math.round(Number(v.price)))}
              </option>
            ))}
          </select>
        </label>

        <label>
          Kirim tiap
          <select name="frequencyDays" defaultValue={String(plans[0]?.days ?? 30)} style={{ display: "block", padding: 8, width: "100%" }}>
            {plans.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}{p.discountPct > 0 ? ` — hemat ${p.discountPct}%` : ""}
              </option>
            ))}
          </select>
        </label>

        <label>
          Jumlah
          <input name="quantity" type="number" min={1} max={10} defaultValue={1} style={{ display: "block", padding: 8, width: "100%" }} />
        </label>

        <label>
          Nama depan
          <input name="givenNames" required style={{ display: "block", padding: 8, width: "100%" }} />
        </label>
        <label>
          Nama belakang (opsional)
          <input name="surname" style={{ display: "block", padding: 8, width: "100%" }} />
        </label>
        <label>
          Email
          <input name="email" type="email" required style={{ display: "block", padding: 8, width: "100%" }} />
        </label>
        <label>
          WhatsApp (format +628…)
          <input name="phone" type="tel" pattern="\+[1-9][0-9]{6,14}" style={{ display: "block", padding: 8, width: "100%" }} />
        </label>

        <label>
          Metode pembayaran
          <select name="paymentMethod" required style={{ display: "block", padding: 8, width: "100%" }}>
            <option value="card">Kartu kredit/debit</option>
            <option value="dana">DANA</option>
            <option value="ovo">OVO</option>
            <option value="gopay">GoPay</option>
            <option value="shopeepay">ShopeePay</option>
          </select>
        </label>

        {/* 🔒 checkbox consent — TIDAK boleh defaultChecked */}
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" name="consent" required />
          <span style={{ fontSize: 14 }}>{CONSENT_TEXT}</span>
        </label>

        {fetcher.data?.error && <p style={{ background: "#fce8e6", padding: 12 }}>{fetcher.data.error}</p>}

        <button type="submit" disabled={fetcher.state !== "idle"} style={{ padding: 14, fontWeight: 700 }}>
          {fetcher.state !== "idle" ? "Memproses…" : "Lanjut ke pembayaran"}
        </button>
      </fetcher.Form>
    </main>
  );
}
