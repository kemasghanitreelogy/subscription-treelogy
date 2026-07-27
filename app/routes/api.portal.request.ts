// Minta magic link portal via email/WA (§7.6). Respons selalu 200 dengan pesan
// yang sama — jangan bocorkan ada/tidaknya langganan untuk sebuah email.
import type { ActionFunctionArgs } from "react-router";
import { pooledDb } from "../db/client.server";
import { issuePortalToken } from "../services/portal-token.server";
import { emitKlaviyoEvent } from "../services/klaviyo.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const generic = { ok: true, message: "Kalau email terdaftar, link portal terkirim." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json(generic);

  const db = pooledDb();
  const { rows } = await db.query(
    `select id, email, phone_e164 from subscriptions
      where lower(email) = $1 and status <> 'cancelled'
      order by created_at desc limit 5`,
    [email],
  );

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  for (const sub of rows) {
    const token = await issuePortalToken(db, sub.id, "full");
    await emitKlaviyoEvent("Portal Link Requested", sub.email, {
      subscription_id: sub.id,
      portal_url: `${appUrl}/portal/${token}`,
      expires_minutes: 15,
    }, sub.phone_e164).catch((err) => console.error("[portal.request] klaviyo", err));
  }
  return Response.json(generic);
};
