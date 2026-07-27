// Aksi portal: Cancel (§7.6) 🔒 — 2 klik, 1 pertanyaan deflection, BUKAN dark
// pattern. cancel_reason disimpan untuk win-back. Retry berhenti total.
import type { ActionFunctionArgs } from "react-router";
import { pooledDb } from "../db/client.server";
import { authorizePortalAction } from "../services/portal-auth.server";
import { cancelSubscription } from "../services/subscription-lifecycle.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const form = await request.formData();
  const db = pooledDb();
  const sub = await authorizePortalAction(db, form, params.id!, "full");
  if (sub instanceof Response) return sub;
  if (sub.status === "cancelled") return Response.json({ ok: true });

  const reason = String(form.get("reason") ?? "").trim().slice(0, 500) || null;
  await cancelSubscription(db, sub, reason, "customer");
  return Response.json({ ok: true });
};
