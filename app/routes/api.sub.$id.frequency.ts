// Aksi portal: Ubah frekuensi (§7.6). Hitung ulang dari charge sukses terakhir,
// wajib lolos assertH3Safe 🔒.
import type { ActionFunctionArgs } from "react-router";
import { pooledDb } from "../db/client.server";
import { authorizePortalAction } from "../services/portal-auth.server";
import { changeFrequency } from "../services/subscription-lifecycle.server";
import { PolicyViolation } from "../services/schedule.server";
import { corsJson } from "../services/cors.server";

const ALLOWED = new Set([30, 60, 90]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return corsJson({ error: "method" }, { status: 405 });
  const form = await request.formData();
  const frequencyDays = Number(form.get("frequencyDays") ?? 0);
  if (!ALLOWED.has(frequencyDays)) {
    return corsJson({ error: "Frekuensi tidak sah (30/60/90 hari)" }, { status: 400 });
  }
  const db = pooledDb();
  const sub = await authorizePortalAction(db, form, params.id!, "full");
  if (sub instanceof Response) return sub;

  try {
    const newDate = await changeFrequency(db, sub, frequencyDays, "customer");
    return corsJson({ ok: true, nextChargeDate: newDate });
  } catch (err) {
    const status = err instanceof PolicyViolation ? 422 : 400;
    return corsJson({ error: err instanceof Error ? err.message : "Gagal" }, { status });
  }
};
