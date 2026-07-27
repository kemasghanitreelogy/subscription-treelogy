// Aksi portal: Re-link wallet (§7.6) — sesi SAVE tanpa menagih. Token baru
// datang lewat webhook payment_session.completed; kalau paused karena token
// mati, resume otomatis (tetap H+3) di processor webhook.
import type { ActionFunctionArgs } from "react-router";
import { pooledDb } from "../db/client.server";
import { authorizePortalAction } from "../services/portal-auth.server";
import { createSaveSession } from "../services/xendit.server";
import { logEvent } from "../services/subscription-lifecycle.server";
import { corsJson } from "../services/cors.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return corsJson({ error: "method" }, { status: 405 });
  const db = pooledDb();
  const sub = await authorizePortalAction(db, await request.formData(), params.id!, "relink");
  if (sub instanceof Response) return sub;
  if (sub.status === "cancelled") {
    return corsJson({ error: "Langganan sudah dibatalkan" }, { status: 400 });
  }

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const session = await createSaveSession({
    referenceId: `relink_${sub.id}_${Date.now()}`,
    customer: {
      referenceId: sub.shopify_customer_gid,
      email: sub.email,
      mobileNumber: sub.phone_e164 ?? undefined,
      givenNames: sub.email.split("@")[0],
    },
    successReturnUrl: `${appUrl}/subscribe/done?sid=${sub.id}&relink=1`,
    cancelReturnUrl: `${appUrl}/subscribe/cancelled?sid=${sub.id}&relink=1`,
  });

  await logEvent(db, sub.id, "relink_started", "customer", {
    payment_session_id: session.payment_session_id,
  });
  return corsJson({ ok: true, paymentUrl: session.payment_link_url });
};
