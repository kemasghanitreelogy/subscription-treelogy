// Aksi portal: Skip satu siklus (§7.6). next_charge_date += frequency_days.
import type { ActionFunctionArgs } from "react-router";
import { pooledDb } from "../db/client.server";
import { authorizePortalAction } from "../services/portal-auth.server";
import { skipCycle } from "../services/subscription-lifecycle.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });
  const db = pooledDb();
  const sub = await authorizePortalAction(db, await request.formData(), params.id!, "skip");
  if (sub instanceof Response) return sub;

  try {
    const newDate = await skipCycle(db, sub, "customer");
    return Response.json({ ok: true, nextChargeDate: newDate });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Gagal skip" }, { status: 400 });
  }
};
