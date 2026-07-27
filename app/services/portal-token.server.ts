// Magic link & deep-link 1-tap (§7.6): token acak, umur 15 menit, sekali pakai,
// scope terbatas, terikat satu subscription. DB hanya menyimpan hash-nya.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

export type PortalScope = "full" | "skip" | "pause" | "relink";

const TOKEN_TTL_MINUTES = 15;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Magic link: TTL default 15 menit. Deep-link WA H-3 (scope aksi tunggal)
 * boleh berumur lebih panjang lewat ttlMinutes — inti janji "1 klik" §7.6.
 */
export async function issuePortalToken(
  db: pg.Pool,
  subscriptionId: string,
  scope: PortalScope,
  ttlMinutes: number = TOKEN_TTL_MINUTES,
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `insert into portal_tokens (token_hash, subscription_id, scope, expires_at)
     values ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [hashToken(token), subscriptionId, scope, ttlMinutes],
  );
  return token;
}

export interface PortalGrant {
  subscriptionId: string;
  scope: PortalScope;
}

/**
 * Validasi + konsumsi token secara atomik. `requiredScope` selain 'full'
 * diterima juga oleh token 'full'. Deep-link (scope aksi) langsung hangus
 * saat dipakai; token 'full' hangus saat aksi mutasi pertama (consume=true).
 */
export async function consumePortalToken(
  db: pg.Pool,
  rawToken: string,
  requiredScope: PortalScope,
  opts: { consume: boolean } = { consume: true },
): Promise<PortalGrant | null> {
  const hash = hashToken(rawToken);
  const { rows } = opts.consume
    ? await db.query(
        `update portal_tokens
            set used_at = now()
          where token_hash = $1 and used_at is null and expires_at > now()
            and (scope = $2 or scope = 'full')
          returning subscription_id, scope`,
        [hash, requiredScope],
      )
    : await db.query(
        `select subscription_id, scope from portal_tokens
          where token_hash = $1 and used_at is null and expires_at > now()
            and (scope = $2 or scope = 'full')`,
        [hash, requiredScope],
      );
  if (!rows.length) return null;
  return { subscriptionId: rows[0].subscription_id, scope: rows[0].scope };
}
