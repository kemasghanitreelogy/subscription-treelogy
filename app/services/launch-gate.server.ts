// Gerbang peluncuran storefront. Sebelum go-live, alur subscribe TIDAK BOLEH
// terlihat/terpakai customer meskipun app sudah ter-install dan live:
//   - STOREFRONT_SUBSCRIBE_ENABLED=true  → terbuka untuk semua
//   - selain itu → 404 untuk publik; hanya ?preview=<SUBSCRIBE_PREVIEW_KEY>
//     (atau field form previewKey) yang bisa masuk, untuk pengujian internal.
// 404 (bukan 403) supaya keberadaan halaman pun tidak bocor.
import { createHash, timingSafeEqual } from "node:crypto";

export function storefrontLive(): boolean {
  return process.env.STOREFRONT_SUBSCRIBE_ENABLED === "true";
}

function keyMatches(candidate: string | null): boolean {
  const expected = process.env.SUBSCRIBE_PREVIEW_KEY;
  if (!expected || !candidate) return false;
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Untuk loader GET: izinkan kalau live, atau ?preview= cocok. */
export function assertSubscribeAccess(request: Request): string | null {
  if (storefrontLive()) return null;
  const preview = new URL(request.url).searchParams.get("preview");
  if (keyMatches(preview)) return preview;
  throw new Response("Not found", { status: 404 });
}

/** Untuk action POST: izinkan kalau live, atau previewKey di form cocok. */
export function assertSubscribeAccessForm(form: FormData): void {
  if (storefrontLive()) return;
  if (keyMatches(String(form.get("previewKey") ?? "") || null)) return;
  throw new Response("Not found", { status: 404 });
}
