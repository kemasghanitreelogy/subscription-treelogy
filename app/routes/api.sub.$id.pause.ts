// Aksi portal: Pause 1–3 bulan, atau resume (§7.6). Resume 🔒 minimal H+3.
import type { ActionFunctionArgs } from "react-router";
import { pooledDb } from "../db/client.server";
import { authorizePortalAction } from "../services/portal-auth.server";
import { pauseSubscription, resumeSubscription } from "../services/subscription-lifecycle.server";
import { PolicyViolation } from "../services/schedule.server";
import { corsJson } from "../services/cors.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return corsJson({ error: "method" }, { status: 405 });
  const form = await request.formData();
  const db = pooledDb();
  const sub = await authorizePortalAction(db, form, params.id!, "pause");
  if (sub instanceof Response) return sub;

  const mode = String(form.get("mode") ?? "pause");
  try {
    if (mode === "resume") {
      const newDate = await resumeSubscription(db, sub, "customer");
      return corsJson({ ok: true, nextChargeDate: newDate });
    }
    const months = Number(form.get("months") ?? 1);
    if (![1, 2, 3].includes(months)) {
      return corsJson({ error: "Durasi pause 1–3 bulan" }, { status: 400 });
    }
    await pauseSubscription(db, sub, months as 1 | 2 | 3, "customer");
    return corsJson({ ok: true });
  } catch (err) {
    const status = err instanceof PolicyViolation ? 422 : 400;
    return corsJson({ error: err instanceof Error ? err.message : "Gagal" }, { status });
  }
};
