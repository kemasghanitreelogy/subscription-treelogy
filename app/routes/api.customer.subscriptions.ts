// Dipanggil customer account extension dengan session token (JWT HS256,
// ditandatangani SHOPIFY_API_SECRET; `sub` = gid pelanggan yang sedang login).
// Mengembalikan langganan milik pelanggan itu + portal URL (token 'full').
import type { LoaderFunctionArgs } from "react-router";
import { createHmac, timingSafeEqual } from "node:crypto";
import { pooledDb } from "../db/client.server";
import { issuePortalToken } from "../services/portal-token.server";

function verifySessionToken(token: string): { sub?: string; dest?: string } | null {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (claims.exp && claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

  const auth = request.headers.get("authorization") ?? "";
  const claims = auth.startsWith("Bearer ") ? verifySessionToken(auth.slice(7)) : null;
  if (!claims?.sub) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS });
  }
  // `sub` pada token customer account = gid pelanggan
  const customerGid = String(claims.sub).startsWith("gid://")
    ? String(claims.sub)
    : `gid://shopify/Customer/${claims.sub}`;

  const db = pooledDb();
  const { rows } = await db.query(
    `select id, status, variant_gid, quantity, unit_amount_idr, shipping_amount_idr,
            frequency_days, next_charge_date, xendit_token_id
       from subscriptions
      where shopify_customer_gid = $1 and status <> 'cancelled'
      order by created_at desc`,
    [customerGid],
  );

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const subscriptions = await Promise.all(
    rows.map(async (s) => ({
      id: s.id,
      status: s.status,
      productTitle: `Langganan tiap ${s.frequency_days} hari`,
      frequencyDays: s.frequency_days,
      nextChargeDate: s.next_charge_date,
      hasPaymentMethod: Boolean(s.xendit_token_id),
      amountLabel: `Rp${(s.unit_amount_idr * s.quantity + s.shipping_amount_idr).toLocaleString("id-ID")}`,
      portalUrl: `${appUrl}/portal/${await issuePortalToken(db, s.id, "full")}`,
    })),
  );

  return Response.json({ subscriptions }, { headers: CORS });
};
