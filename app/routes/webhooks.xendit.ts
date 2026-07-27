// Webhook Xendit (§5.4). Urutan WAJIB:
//   1. verifikasi x-callback-token — sebelum parsing apa pun
//   2. INSERT webhook_events — konflik berarti duplikat → tetap 200, berhenti
//   3. balas 200 SECEPATNYA
//   4. proses di luar request cycle (fire-and-forget di sini + worker sebagai
//      jaring pengaman tiap tick)
import type { ActionFunctionArgs } from "react-router";
import { pooledDb } from "../db/client.server";
import { verifyCallbackToken, type XenditWebhookPayload } from "../services/xendit.server";
import { claimAndProcessXenditEvents, enqueueWebhookEvent } from "../services/webhook-queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!verifyCallbackToken(request.headers.get("x-callback-token"))) {
    return new Response("unauthorized", { status: 401 });
  }

  let payload: XenditWebhookPayload;
  try {
    payload = (await request.json()) as XenditWebhookPayload;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const db = pooledDb();
  // ID deterministik dari isi payload — header id provider tidak diandalkan.
  const dataId =
    payload.data?.payment_id ?? payload.data?.payment_request_id ?? payload.data?.payment_token_id ?? "unknown";
  const externalId = `${payload.event}:${dataId}:${payload.created}`;

  const isNew = await enqueueWebhookEvent(db, "xendit", externalId, payload.event, payload);

  if (isNew) {
    // Proses segera tanpa menahan respons; worker mengulang yang gagal.
    void claimAndProcessXenditEvents(db).catch((err) =>
      console.error("[webhooks.xendit] pemrosesan segera gagal", err),
    );
  }

  return new Response("ok", { status: 200 });
};
