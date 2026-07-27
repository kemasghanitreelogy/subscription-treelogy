// F1 · Subscribe — charge pertama (§7.1).
// Consent WAJIB dicentang sendiri (bukan pre-ticked) dan teksnya disimpan
// LITERAL (§10.2). Harga diambil dari Shopify di server — jangan percaya angka
// dari client.
import type { ActionFunctionArgs } from "react-router";
import { pooledDb, isUniqueViolation } from "../db/client.server";
import { idempotencyKey, todayWIB, totalAmountIdr } from "../services/schedule.server";
import { createPaymentSession } from "../services/xendit.server";
import { findCustomerGidByEmail, getVariant } from "../services/shopify-order.server";
import { logEvent } from "../services/subscription-lifecycle.server";
import { discountedUnitIdr, getSettings, productSubscribable } from "../services/settings.server";
import { assertSubscribeAccessForm } from "../services/launch-gate.server";

const ALLOWED_METHODS = new Set(["card", "ovo", "dana", "gopay", "shopeepay"]);

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return Response.json({ error: "method" }, { status: 405 });

  const form = await request.formData();
  assertSubscribeAccessForm(form); // pra-launch: 404 untuk publik
  const variantGid = String(form.get("variantGid") ?? "");
  const quantity = Number(form.get("quantity") ?? 1);
  const frequencyDays = Number(form.get("frequencyDays") ?? 0);
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const phone = String(form.get("phone") ?? "").trim() || null;
  const givenNames = String(form.get("givenNames") ?? "").trim();
  const surname = String(form.get("surname") ?? "").trim() || null;
  const paymentMethod = String(form.get("paymentMethod") ?? "");
  const consentChecked = form.get("consent") === "on" || form.get("consent") === "true";
  const consentText = String(form.get("consentText") ?? "").trim();

  if (!variantGid.startsWith("gid://shopify/ProductVariant/"))
    return Response.json({ error: "Varian tidak sah" }, { status: 400 });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10)
    return Response.json({ error: "Jumlah tidak sah" }, { status: 400 });
  const settings = await getSettings(pooledDb());
  const plan = settings.plans.find((p) => p.enabled && p.days === frequencyDays);
  if (!plan) return Response.json({ error: "Frekuensi tidak sah" }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return Response.json({ error: "Email tidak sah" }, { status: 400 });
  if (phone && !/^\+[1-9]\d{6,14}$/.test(phone))
    return Response.json({ error: "Nomor WA harus format E.164 (+628…)" }, { status: 400 });
  if (!givenNames) return Response.json({ error: "Nama wajib diisi" }, { status: 400 });
  if (!ALLOWED_METHODS.has(paymentMethod))
    return Response.json({ error: "Metode pembayaran tidak sah" }, { status: 400 });
  // 🔒 aturan consent autodebet: harus tindakan aktif + teks yang dilihat tersimpan
  if (!consentChecked || !consentText)
    return Response.json({ error: "Persetujuan autodebet wajib dicentang" }, { status: 400 });

  const variant = await getVariant(variantGid);
  if (!variant) return Response.json({ error: "Varian tidak ditemukan" }, { status: 400 });
  if (!productSubscribable(settings, variant.product?.id)) {
    return Response.json({ error: "Produk ini tidak tersedia untuk langganan" }, { status: 400 });
  }

  // Harga Shopify dalam desimal string ("586500.00") — IDR tidak berdesimal.
  // Diskon plan diterapkan di server; client tidak pernah menentukan harga.
  const baseUnitIdr = Math.round(Number(variant.price));
  const unitAmountIdr = discountedUnitIdr(baseUnitIdr, plan);
  const shippingAmountIdr = settings.shippingAmountIdr;
  const amountIdr = totalAmountIdr(unitAmountIdr, quantity, shippingAmountIdr);

  const db = pooledDb();
  const cycleDate = todayWIB();
  const customerGid = (await findCustomerGidByEmail(email)) ?? `pending:${email}`;
  const consentIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

  // Submit dobel (§7.1): pakai kembali langganan pending yang sama, jangan buat dua.
  const { rows: existing } = await db.query(
    `select s.id from subscriptions s
      where s.email = $1 and s.variant_gid = $2 and s.xendit_token_id is null
        and s.created_at > now() - interval '1 hour'
        and not exists (select 1 from charges c where c.subscription_id = s.id and c.status = 'succeeded')
      limit 1`,
    [email, variantGid],
  );

  let subscriptionId: string;
  if (existing.length) {
    subscriptionId = existing[0].id;
  } else {
    const { rows } = await db.query(
      `insert into subscriptions
         (shopify_customer_gid, email, phone_e164, variant_gid, quantity,
          unit_amount_idr, shipping_amount_idr, frequency_days, status,
          payment_method, next_charge_date, next_attempt_at,
          consent_text, consent_at, consent_ip)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,now(),$11,now(),$12)
       returning id`,
      [
        customerGid, email, phone, variantGid, quantity,
        unitAmountIdr, shippingAmountIdr, frequencyDays,
        paymentMethod, cycleDate, consentText, consentIp,
      ],
    );
    subscriptionId = rows[0].id;
  }

  const referenceId = idempotencyKey(subscriptionId, cycleDate, 1);
  try {
    await db.query(
      `insert into charges (subscription_id, scheduled_for, attempt_n, status, amount_idr, idempotency_key)
       values ($1, $2, 1, 'pending', $3, $4)`,
      [subscriptionId, cycleDate, amountIdr, referenceId],
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err; // duplikat = charge pertama sudah tercatat, lanjut
  }

  const appUrl = process.env.SHOPIFY_APP_URL || "";
  const session = await createPaymentSession({
    referenceId,
    amountIdr,
    customer: {
      referenceId: customerGid,
      email,
      mobileNumber: phone ?? undefined,
      givenNames,
      surname: surname ?? undefined,
    },
    items: [
      {
        referenceId: variantGid,
        name: `${variant.product?.title ?? "Treelogy"} — ${variant.title}`,
        netUnitAmountIdr: unitAmountIdr,
        quantity,
      },
    ],
    // ADR-03 🔒: "tiap N hari", BUKAN "tiap bulan"
    description: `Langganan Treelogy tiap ${frequencyDays} hari`,
    successReturnUrl: `${appUrl}/subscribe/done?sid=${subscriptionId}`,
    cancelReturnUrl: `${appUrl}/subscribe/cancelled?sid=${subscriptionId}`,
  });

  await logEvent(db, subscriptionId, "created", "customer", {
    payment_session_id: session.payment_session_id,
    frequency_days: frequencyDays,
    amount_idr: amountIdr,
  });

  return Response.json({ subscriptionId, paymentUrl: session.payment_link_url });
};
