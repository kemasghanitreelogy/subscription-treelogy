// Respons JSON dengan CORS terbuka — dipakai API portal yang dipanggil dari
// customer account extension (origin sandbox Shopify). Otorisasi TIDAK
// bergantung origin, melainkan token portal sekali pakai di body.
export function corsJson(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "authorization, content-type");
  return Response.json(data, { ...init, headers });
}
