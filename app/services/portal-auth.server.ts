// Otorisasi aksi portal: token sekali pakai + scope + kecocokan subscription.
import type pg from "pg";
import { consumePortalToken, type PortalScope } from "./portal-token.server";
import type { SubscriptionRow } from "./subscription-lifecycle.server";
import { corsJson } from "./cors.server";

export async function authorizePortalAction(
  db: pg.Pool,
  form: FormData,
  subscriptionId: string,
  scope: PortalScope,
): Promise<SubscriptionRow | Response> {
  const token = String(form.get("token") ?? "");
  if (!token) return corsJson({ error: "Token wajib" }, { status: 401 });

  const grant = await consumePortalToken(db, token, scope);
  if (!grant || grant.subscriptionId !== subscriptionId) {
    return corsJson({ error: "Link kedaluwarsa atau tidak sah — minta link baru" }, { status: 401 });
  }

  const { rows } = await db.query("select * from subscriptions where id = $1", [subscriptionId]);
  if (!rows.length) return corsJson({ error: "Langganan tidak ditemukan" }, { status: 404 });
  return rows[0] as SubscriptionRow;
}
