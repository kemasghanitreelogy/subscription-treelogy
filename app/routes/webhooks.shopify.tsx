// Webhook Shopify (§6.3): app/uninstalled, app/scopes_update, dan compliance
// (GDPR). customers/redact: ANONIMKAN PII, JANGAN hapus charges — catatan
// keuangan punya kewajiban retensi sendiri (§10.3).
import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { pooledDb } from "../db/client.server";
import { enqueueWebhookEvent } from "../services/webhook-queue.server";
import { logEvent } from "../services/subscription-lifecycle.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload, session } = await authenticate.webhook(request);
  const db = pooledDb();

  // Dedup — Shopify juga mengirim ulang saat ragu.
  const isNew = await enqueueWebhookEvent(db, "shopify", webhookId, topic, payload);
  if (!isNew) return new Response();

  switch (topic) {
    case "APP_UNINSTALLED": {
      // Tanpa ini, app memanggil API dengan token mati selamanya.
      if (session) {
        const sessions = await sessionStorage.findSessionsByShop(shop);
        if (sessions.length) {
          await sessionStorage.deleteSessions(sessions.map((s) => s.id));
        }
      }
      break;
    }

    case "APP_SCOPES_UPDATE":
      // Session storage menyimpan scope baru saat re-auth; cukup dicatat.
      break;

    case "CUSTOMERS_DATA_REQUEST":
      // Kewajiban privasi: permintaan ekspor ditangani manual — baris
      // webhook_events di atas adalah bukti penerimaannya.
      break;

    case "CUSTOMERS_REDACT": {
      const customerGid = `gid://shopify/Customer/${(payload as { customer?: { id?: number } }).customer?.id ?? ""}`;
      const { rows } = await db.query(
        "select id from subscriptions where shopify_customer_gid = $1",
        [customerGid],
      );
      for (const { id } of rows) {
        await db.query(
          `update subscriptions
              set email = 'redacted+' || id || '@redacted.invalid',
                  phone_e164 = null,
                  consent_ip = null
            where id = $1`,
          [id],
        );
        await logEvent(db, id, "customer_redacted", "system", { topic });
      }
      break;
    }

    case "SHOP_REDACT": {
      await db.query(
        `update subscriptions
            set email = 'redacted+' || id || '@redacted.invalid',
                phone_e164 = null,
                consent_ip = null`,
      );
      break;
    }

    default:
      console.warn(`[webhooks.shopify] topic tidak ditangani: ${topic}`);
  }

  await db.query("update webhook_events set processed_at = now() where source = 'shopify' and external_id = $1", [
    webhookId,
  ]);
  return new Response();
};
