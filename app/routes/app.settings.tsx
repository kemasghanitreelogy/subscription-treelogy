// "Pengaturan" — setup guide + status integrasi. Meniru halaman Settings app
// Subscriptions native (widget snippet, management URL) tapi dengan health
// check nyata: Xendit, Klaviyo, worker heartbeat, webhook.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, STORE_NAME } from "../shopify.server";
import { pooledDb } from "../db/client.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const db = pooledDb();
  const appUrl = process.env.SHOPIFY_APP_URL || "";

  const [hb, unprocessed] = await Promise.all([
    db.query("select last_tick_at from worker_heartbeat where worker_name = 'worker'"),
    db.query("select count(*)::int as n from webhook_events where processed_at is null"),
  ]);
  const heartbeatAgeMin = hb.rows.length
    ? Math.round((Date.now() - new Date(hb.rows[0].last_tick_at).getTime()) / 60000)
    : null;

  return {
    appUrl,
    storeName: STORE_NAME,
    checks: {
      database: true, // query di atas berhasil berarti Neon hidup
      worker: heartbeatAgeMin !== null && heartbeatAgeMin <= 15,
      heartbeatAgeMin,
      xendit: Boolean(process.env.XENDIT_SECRET_KEY && process.env.XENDIT_WEBHOOK_TOKEN),
      klaviyo: Boolean(process.env.KLAVIYO_PRIVATE_KEY),
      unprocessedWebhooks: unprocessed.rows[0].n,
    },
  };
};

function Check({ ok, label, detail }: { ok: boolean; label: string; detail?: string }) {
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <s-badge tone={ok ? "success" : "critical"} icon={ok ? "check-circle" : "alert-circle"}>
        {ok ? "OK" : "Perlu tindakan"}
      </s-badge>
      <s-text type="strong">{label}</s-text>
      {detail && <s-text color="subdued">{detail}</s-text>}
    </s-stack>
  );
}

export default function Settings() {
  const { appUrl, storeName, checks } = useLoaderData<typeof loader>();
  const widgetUrl = `${appUrl}/subscribe/`;

  return (
    <s-page heading="Pengaturan" inlineSize="small">
      <s-section heading="Status sistem">
        <s-stack direction="block" gap="base">
          <Check ok={checks.database} label="Database (Neon)" />
          <Check
            ok={checks.worker}
            label="Worker penagihan"
            detail={
              checks.heartbeatAgeMin === null
                ? "belum pernah tick"
                : `tick terakhir ${checks.heartbeatAgeMin} menit lalu`
            }
          />
          <Check
            ok={checks.xendit}
            label="Xendit"
            detail={checks.xendit ? undefined : "isi XENDIT_SECRET_KEY + XENDIT_WEBHOOK_TOKEN di fly secrets"}
          />
          <Check
            ok={checks.klaviyo}
            label="Klaviyo (WA/email)"
            detail={
              checks.klaviyo
                ? undefined
                : "tanpa ini charge DITUNDA — reminder H-3 adalah janji legal"
            }
          />
          <Check
            ok={checks.unprocessedWebhooks < 100}
            label="Antrian webhook"
            detail={`${checks.unprocessedWebhooks} belum diproses`}
          />
        </s-stack>
      </s-section>

      <s-section heading="Kebijakan penagihan (tidak bisa diubah)">
        <s-paragraph color="subdued">
          Nilai-nilai ini mengikat ke halaman kebijakan langganan di storefront — mengubahnya
          berarti mengubah halaman policy lebih dulu.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Reminder H-3 sebelum setiap tagihan (charge ditunda kalau reminder gagal)</s-list-item>
          <s-list-item>Jam tagih 10:00 WIB · reminder 09:00 WIB</s-list-item>
          <s-list-item>Retry gagal bayar: +6 jam → +24 jam (14:00) → +72 jam → hari 5–7 sadar-gajian</s-list-item>
          <s-list-item>Semua retry habis → langganan DIJEDA otomatis, bukan dibatalkan</s-list-item>
          <s-list-item>Batal = berhenti menagih seketika, 2 klik, tanpa dark pattern</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Widget halaman produk">
        <s-paragraph>
          Tambahkan block <s-text type="strong">"Kotak Langganan Treelogy"</s-text> lewat theme
          editor (Apps → Treelogy Subscriptions) di template produk. Tanpa coding — block
          otomatis mengarah ke alur subscribe produk tersebut.
        </s-paragraph>
        <s-button href={`https://admin.shopify.com/store/${storeName.replace(".myshopify.com", "")}/themes/current/editor?template=product`}>
          Buka theme editor
        </s-button>
      </s-section>

      <s-section heading="URL manajemen langganan">
        <s-paragraph>
          Halaman <s-text type="strong">"Langganan"</s-text> (kelola langganan pelanggan: lewati,
          jeda, lanjut, batal) sudah terpasang otomatis di akun pelanggan sebagai halaman penuh.
          Tambahkan ke menu akun pelanggan lewat editor — dari sana URL halamannya juga bisa
          disalin untuk dipasang di navigasi toko atau email.
        </s-paragraph>
        <s-ordered-list>
          <s-list-item>Buka editor Checkout & akun pelanggan</s-list-item>
          <s-list-item>Pilih tampilan Customer accounts → Menu</s-list-item>
          <s-list-item>Add menu item → pilih halaman "Treelogy Subscriptions"</s-list-item>
        </s-ordered-list>
        <s-button
          variant="primary"
          href={`https://admin.shopify.com/store/${storeName.replace(".myshopify.com", "")}/settings/checkout/editor`}
        >
          Buka editor akun pelanggan
        </s-button>
      </s-section>

      <s-section heading="URL penting">
        <s-unordered-list>
          <s-list-item>
            Express subscribe: <s-link href={widgetUrl}>{widgetUrl}&lt;handle-produk&gt;</s-link>
          </s-list-item>
          <s-list-item>
            Portal pelanggan: menu "Langganan" di akun pelanggan (customer account extension),
            atau magic link via email/WA
          </s-list-item>
          <s-list-item>Webhook Xendit: {appUrl}/webhooks/xendit</s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
