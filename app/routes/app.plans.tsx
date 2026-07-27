// "Plans" — konfigurasi frekuensi + diskon + ongkir. Pengganti selling plan
// app native, tapi satu layar tanpa nested form. Harga final selalu dihitung
// server-side dari sini (bukan dari client).
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { pooledDb } from "../db/client.server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { getSettings, saveSettings, type AppSettings, type PlanProduct } from "../services/settings.server";
import { logEvent } from "../services/subscription-lifecycle.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return { settings: await getSettings(pooledDb()) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const db = pooledDb();
  const intent = String(form.get("intent") ?? "plans");

  try {
    if (intent === "products") {
      const products = JSON.parse(String(form.get("products") ?? "[]")) as PlanProduct[];
      await saveSettings(db, { products });
      await logEvent(db, null, "plan_products_updated", `admin:${session.shop}`, {
        count: products.length,
      });
      return Response.json({ ok: true });
    }

    const patch: Partial<AppSettings> = {
      plans: ([30, 60, 90] as const).map((days) => ({
        days,
        enabled: form.get(`enabled_${days}`) === "on",
        discountPct: Number(form.get(`discount_${days}`) ?? 0),
        label: `Tiap ${days} hari`,
      })),
      shippingAmountIdr: Number(form.get("shipping") ?? 0),
    };
    await saveSettings(db, patch);
    await logEvent(db, null, "plans_updated", `admin:${session.shop}`, patch as unknown as Record<string, unknown>);
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Gagal menyimpan" }, { status: 400 });
  }
};

export default function Plans() {
  const { settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  const saveProducts = (products: PlanProduct[]) => {
    const fd = new FormData();
    fd.set("intent", "products");
    fd.set("products", JSON.stringify(products));
    fetcher.submit(fd, { method: "post" });
  };

  const pickProducts = async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      selectionIds: settings.products.map((p) => ({ id: p.gid })),
    });
    if (!selected) return; // dibatalkan
    saveProducts(
      selected.map((p) => ({
        gid: p.id,
        title: "title" in p ? (p.title ?? "") : "",
        handle: "handle" in p ? ((p as { handle?: string }).handle ?? "") : "",
        imageUrl: (p as { images?: Array<{ originalSrc?: string }> }).images?.[0]?.originalSrc ?? null,
      })),
    );
  };

  return (
    <s-page heading="Plans" inlineSize="small">
      {fetcher.data?.ok && <s-banner tone="success" heading="Tersimpan — langsung berlaku untuk subscribe berikutnya" dismissible></s-banner>}
      {fetcher.data?.error && <s-banner tone="critical" heading={fetcher.data.error} dismissible></s-banner>}

      <s-section heading="Produk yang bisa dilanggan">
        <s-paragraph color="subdued">
          {settings.products.length === 0
            ? "Saat ini SEMUA produk bisa dilanggan. Pilih produk untuk membatasinya."
            : `Hanya ${settings.products.length} produk terpilih yang bisa dilanggan — produk lain otomatis ditolak di halaman subscribe dan API.`}
        </s-paragraph>
        <s-stack direction="block" gap="small-200">
          {settings.products.map((p) => (
            <s-stack key={p.gid} direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-stack direction="inline" gap="small-200" alignItems="center">
                {p.imageUrl && <s-thumbnail src={p.imageUrl} alt={p.title} size="small"></s-thumbnail>}
                <s-text>{p.title}</s-text>
              </s-stack>
              <s-button
                variant="tertiary"
                tone="critical"
                disabled={busy}
                onClick={() => saveProducts(settings.products.filter((x) => x.gid !== p.gid))}
              >
                Hapus
              </s-button>
            </s-stack>
          ))}
        </s-stack>
        <s-button onClick={pickProducts} disabled={busy}>
          {settings.products.length ? "Ubah pilihan produk" : "Pilih produk"}
        </s-button>
      </s-section>

      <fetcher.Form method="post">
        <s-section heading="Frekuensi & diskon">
          <s-paragraph color="subdued">
            Diskon dihitung dari harga varian saat pelanggan subscribe. Copy storefront memakai
            "tiap N hari" — bukan "per bulan" — sesuai halaman kebijakan langganan.
          </s-paragraph>
          <s-stack direction="block" gap="base">
            {settings.plans.map((p) => (
              <s-box key={p.days} padding="base" background="subdued" borderRadius="base">
                <s-grid gridTemplateColumns="1fr 1fr" gap="base">
                  <s-switch label={p.label} name={`enabled_${p.days}`} checked={p.enabled}></s-switch>
                  <s-number-field
                    label="Diskon (%)"
                    name={`discount_${p.days}`}
                    defaultValue={String(p.discountPct)}
                    min={0}
                    max={50}
                    step={1}
                  ></s-number-field>
                </s-grid>
              </s-box>
            ))}
          </s-stack>
        </s-section>

        <s-section heading="Ongkos kirim per siklus">
          <s-number-field
            label="Ongkir (Rp)"
            name="shipping"
            defaultValue={String(settings.shippingAmountIdr)}
            min={0}
            step={1000}
            details="Ditambahkan ke setiap tagihan siklus. 0 = gratis ongkir."
          ></s-number-field>
        </s-section>

        <s-section>
          <s-button variant="primary" type="submit" disabled={busy} loading={busy}>
            Simpan
          </s-button>
        </s-section>
      </fetcher.Form>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
