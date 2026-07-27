// Emit event lifecycle ke Klaviyo (WA + email dikirim oleh flow Klaviyo).
// Nama event = kontrak dengan flow: Subscription Created, Upcoming Charge,
// Charge Succeeded, Charge Failed, Subscription Paused, Subscription Cancelled,
// Token Expiring.
const KLAVIYO_URL = "https://a.klaviyo.com/api/events";
const KLAVIYO_REVISION = process.env.KLAVIYO_API_REVISION || "2025-07-15";

export async function emitKlaviyoEvent(
  eventName: string,
  email: string,
  properties: Record<string, unknown>,
  phoneE164?: string | null,
): Promise<void> {
  const key = process.env.KLAVIYO_PRIVATE_KEY;
  if (!key) {
    // WAJIB throw, jangan skip diam-diam: kalau di-skip, baris notifications
    // tetap tercatat "terkirim" padahal tidak — reminder H-3 adalah janji legal,
    // dan gate F2 justru HARUS menunda charge saat pengiriman tidak mungkin.
    throw new Error(`KLAVIYO_PRIVATE_KEY kosong — event "${eventName}" tidak bisa dikirim`);
  }
  const res = await fetch(KLAVIYO_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.api+json",
      Authorization: `Klaviyo-API-Key ${key}`,
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify({
      data: {
        type: "event",
        attributes: {
          properties,
          metric: { data: { type: "metric", attributes: { name: eventName } } },
          profile: {
            data: {
              type: "profile",
              attributes: { email, ...(phoneE164 ? { phone_number: phoneE164 } : {}) },
            },
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Klaviyo event "${eventName}" gagal: ${res.status} ${body}`);
  }
}
