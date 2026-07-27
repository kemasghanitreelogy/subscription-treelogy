// "Pengaturan" — layout beranotasi ala app Subscriptions native (label kiri,
// kartu kanan): widget PDP (deep link tambah app block sekali klik), URL
// manajemen langganan (simpan + copy), notifikasi, status sistem.
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate, STORE_NAME } from "../shopify.server";
import { pooledDb } from "../db/client.server";
import { getManagementUrl, saveManagementUrl } from "../services/settings.server";

// uid theme app extension + handle block — untuk deep link "tambah block" di editor
const THEME_EXT_UID = "277ae083-dfcd-a386-798b-084e9161d6ad95ef2b0b";
const BLOCK_HANDLE = "subscription_box";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const db = pooledDb();
  const [hb, unprocessed, managementUrl] = await Promise.all([
    db.query("select last_tick_at from worker_heartbeat where worker_name = 'worker'"),
    db.query("select count(*)::int as n from webhook_events where processed_at is null"),
    getManagementUrl(db),
  ]);
  const heartbeatAgeMin = hb.rows.length
    ? Math.round((Date.now() - new Date(hb.rows[0].last_tick_at).getTime()) / 60000)
    : null;
  const storeHandle = STORE_NAME.replace(".myshopify.com", "");

  return {
    appUrl: process.env.SHOPIFY_APP_URL || "",
    storeHandle,
    managementUrl,
    storefrontLive: process.env.STOREFRONT_SUBSCRIBE_ENABLED === "true",
    checks: {
      worker: heartbeatAgeMin !== null && heartbeatAgeMin <= 15,
      heartbeatAgeMin,
      xendit: Boolean(process.env.XENDIT_SECRET_KEY && process.env.XENDIT_WEBHOOK_TOKEN),
      klaviyo: Boolean(process.env.KLAVIYO_PRIVATE_KEY),
      unprocessedWebhooks: unprocessed.rows[0].n,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  try {
    await saveManagementUrl(pooledDb(), String(form.get("managementUrl") ?? "").trim());
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Gagal" }, { status: 400 });
  }
};

function Row({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <s-grid gridTemplateColumns="1fr 2fr" gap="large">
      <s-box paddingBlockStart="base">
        <s-heading>{label}</s-heading>
        {description && <s-paragraph color="subdued">{description}</s-paragraph>}
      </s-box>
      <s-stack direction="block" gap="base">{children}</s-stack>
    </s-grid>
  );
}

export default function Settings() {
  const { appUrl, storeHandle, managementUrl, storefrontLive, checks } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  const themeEditorUrl = `https://admin.shopify.com/store/${storeHandle}/themes/current/editor?template=product`;
  const addBlockUrl = `${themeEditorUrl}&addAppBlockId=${THEME_EXT_UID}/${BLOCK_HANDLE}&target=mainSection`;
  const accountsEditorUrl = `https://admin.shopify.com/store/${storeHandle}/settings/checkout/editor`;

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    shopify.toast.show("Tersalin");
  };

  return (
    <s-page heading="Pengaturan" inlineSize="large">
      <s-section>
        <s-stack direction="block" gap="large-300">

          <Row label="Widget langganan" description="Kotak langganan di halaman produk.">
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>Pasang widget di template produk</s-heading>
                <s-paragraph>
                  Tanpa menyentuh kode: klik tombol di bawah, block{" "}
                  <s-text type="strong">"Kotak Langganan Treelogy"</s-text> langsung ditambahkan ke
                  template produk di theme editor — tinggal geser posisinya lalu Save.
                </s-paragraph>
                <s-button-group>
                  <s-button variant="primary" href={addBlockUrl} target="_blank">
                    Tambahkan widget ke theme editor
                  </s-button>
                  <s-button href={themeEditorUrl} target="_blank">Buka theme editor</s-button>
                </s-button-group>
              </s-stack>
            </s-box>

            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>Tampilkan langganan di toko</s-heading>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={storefrontLive ? "success" : "caution"}>
                    {storefrontLive ? "LIVE — pelanggan bisa subscribe" : "Belum live (mode pratinjau)"}
                  </s-badge>
                </s-stack>
                <s-paragraph color="subdued">
                  {storefrontLive
                    ? "Alur subscribe terbuka untuk semua pelanggan."
                    : "Halaman subscribe mengembalikan 404 untuk publik — pelanggan tidak bisa melihat atau memakai langganan meski widget terpasang. Untuk go-live: set STOREFRONT_SUBSCRIBE_ENABLED=true di fly secrets, lalu deploy ulang."}
                </s-paragraph>
              </s-stack>
            </s-box>
          </Row>

          <s-divider></s-divider>

          <Row
            label="URL manajemen langganan"
            description="Pintu masuk pelanggan ke halaman kelola langganan."
          >
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>Tambahkan URL manajemen ke navigasimu</s-heading>
                <s-paragraph>
                  Halaman "Langganan" sudah terpasang otomatis di akun pelanggan. Ambil URL-nya
                  sekali dari editor akun pelanggan (Menu → Add menu item → pilih halaman{" "}
                  <s-text type="strong">Treelogy Subscriptions</s-text> → salin URL), tempel di
                  sini supaya selalu bisa disalin ulang untuk navigasi toko, email, atau WA.
                </s-paragraph>

                {managementUrl && (
                  <s-box padding="base" background="subdued" borderRadius="base">
                    <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                      <s-text>{managementUrl}</s-text>
                      <s-button variant="tertiary" icon="clipboard" onClick={() => copy(managementUrl)}>
                        Copy
                      </s-button>
                    </s-stack>
                  </s-box>
                )}

                <fetcher.Form method="post">
                  <s-stack direction="inline" gap="small-200" alignItems="end">
                    <s-url-field
                      label={managementUrl ? "Ganti URL" : "Tempel URL dari editor"}
                      name="managementUrl"
                      placeholder="https://account.treelogy.com/pages/…"
                      defaultValue={managementUrl ?? ""}
                    ></s-url-field>
                    <s-button type="submit" disabled={busy} loading={busy}>Simpan</s-button>
                  </s-stack>
                </fetcher.Form>
                {fetcher.data?.error && <s-text tone="critical">{fetcher.data.error}</s-text>}
                {fetcher.data?.ok && <s-text tone="success">Tersimpan</s-text>}

                <s-button href={accountsEditorUrl} target="_blank">Buka editor akun pelanggan</s-button>
              </s-stack>
            </s-box>
          </Row>

          <s-divider></s-divider>

          <Row
            label="Notifikasi langganan"
            description="WA & email dikirim lewat flow Klaviyo."
          >
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-heading>Kustomisasi notifikasi</s-heading>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={checks.klaviyo ? "success" : "critical"}>
                    {checks.klaviyo ? "Klaviyo terhubung" : "Klaviyo belum terhubung"}
                  </s-badge>
                  {!checks.klaviyo && (
                    <s-text color="subdued">tanpa ini charge DITUNDA — reminder H-3 janji legal</s-text>
                  )}
                </s-stack>
                <s-paragraph>
                  App mengirim event ke Klaviyo; kamu mengatur isi pesan & kanal (WA/email) di flow
                  Klaviyo untuk event: <s-text type="strong">Subscription Created</s-text>,{" "}
                  <s-text type="strong">Upcoming Charge</s-text> (H-3, berisi link 1-klik Skip/Jeda),{" "}
                  <s-text type="strong">Charge Succeeded</s-text>, <s-text type="strong">Charge Failed</s-text>,{" "}
                  <s-text type="strong">Subscription Paused/Cancelled</s-text>,{" "}
                  <s-text type="strong">Token Expiring</s-text>, <s-text type="strong">Portal Link Requested</s-text>.
                </s-paragraph>
                <s-button href="https://www.klaviyo.com/dashboard" target="_blank">Buka Klaviyo</s-button>
              </s-stack>
            </s-box>
          </Row>

          <s-divider></s-divider>

          <Row label="Status sistem" description="Kesehatan mesin penagihan.">
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="base">
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone="success" icon="check-circle">OK</s-badge>
                  <s-text type="strong">Database (Neon)</s-text>
                </s-stack>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={checks.worker ? "success" : "critical"} icon={checks.worker ? "check-circle" : "alert-circle"}>
                    {checks.worker ? "OK" : "Perlu tindakan"}
                  </s-badge>
                  <s-text type="strong">Worker penagihan</s-text>
                  <s-text color="subdued">
                    {checks.heartbeatAgeMin === null ? "belum pernah tick" : `tick terakhir ${checks.heartbeatAgeMin} menit lalu`}
                  </s-text>
                </s-stack>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={checks.xendit ? "success" : "critical"} icon={checks.xendit ? "check-circle" : "alert-circle"}>
                    {checks.xendit ? "OK" : "Perlu tindakan"}
                  </s-badge>
                  <s-text type="strong">Xendit</s-text>
                  {!checks.xendit && <s-text color="subdued">isi XENDIT_SECRET_KEY + XENDIT_WEBHOOK_TOKEN</s-text>}
                </s-stack>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-badge tone={checks.unprocessedWebhooks < 100 ? "success" : "warning"}>
                    {String(checks.unprocessedWebhooks)}
                  </s-badge>
                  <s-text type="strong">Antrian webhook belum diproses</s-text>
                </s-stack>
                <s-paragraph color="subdued">
                  Webhook Xendit: {appUrl}/webhooks/xendit · Kebijakan terkunci: reminder H-3,
                  tagih 10:00 WIB, retry +6j → +24j → +72j → hari 5–7 sadar-gajian, gagal total →
                  jeda otomatis (bukan batal).
                </s-paragraph>
              </s-stack>
            </s-box>
          </Row>

        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
