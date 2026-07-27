// Klien Xendit. Bentuk API diverifikasi lawan docs live 27 Jul 2026 — lihat
// claudedocs/workflow_treelogy-subscriptions_implementation.md §0:
//   - Charge pertama (hosted): POST /sessions → payment_session_id + payment_link_url
//   - Charge berulang (MIT):   POST /v3/payment_requests, request_amount number,
//                              capture_method AUTOMATIC, payment_token_id top-level
//   - Webhook: header x-callback-token, event payment.capture / payment.failure /
//              payment_token.activation / payment_token.failure / payment_token.expiry
import { createHash, timingSafeEqual } from "node:crypto";

const BASE_URL = "https://api.xendit.co";

class XenditError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
  }
}
export { XenditError };

function authHeader(): string {
  const key = process.env.XENDIT_SECRET_KEY;
  if (!key) throw new Error("XENDIT_SECRET_KEY wajib diisi");
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function xenditFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader() },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as T | null;
  if (!res.ok) {
    throw new XenditError(`Xendit ${path} → ${res.status}`, res.status, json);
  }
  return json as T;
}

// ── Charge pertama: Payment Session (hosted — PCI scope tetap SAQ-A) ─────────

export interface CreateSessionInput {
  referenceId: string; // = idempotencyKey siklus pertama
  amountIdr: number;
  customer: {
    referenceId: string; // shopify customer gid
    email: string;
    mobileNumber?: string;
    givenNames: string;
    surname?: string;
  };
  items: Array<{ referenceId: string; name: string; netUnitAmountIdr: number; quantity: number }>;
  description: string;
  successReturnUrl: string;
  cancelReturnUrl: string;
}

export interface PaymentSession {
  payment_session_id: string;
  payment_link_url: string;
  status?: string;
}

export async function createPaymentSession(input: CreateSessionInput): Promise<PaymentSession> {
  return xenditFetch<PaymentSession>("/sessions", {
    reference_id: input.referenceId,
    session_type: "PAY",
    mode: "PAYMENT_LINK",
    // FORCED: menyimpan metode adalah inti produk langganan; tervalidasi docs live
    // (nilai sah: FORCED | OPTIONAL).
    allow_save_payment_method: "FORCED",
    country: "ID",
    currency: "IDR",
    amount: input.amountIdr,
    channel_properties: {
      cards: { card_on_file_type: "RECURRING" },
    },
    customer: {
      reference_id: input.customer.referenceId,
      type: "INDIVIDUAL",
      email: input.customer.email,
      ...(input.customer.mobileNumber ? { mobile_number: input.customer.mobileNumber } : {}),
      individual_detail: {
        given_names: input.customer.givenNames,
        ...(input.customer.surname ? { surname: input.customer.surname } : {}),
      },
    },
    items: input.items.map((it) => ({
      reference_id: it.referenceId,
      name: it.name,
      type: "PHYSICAL_PRODUCT",
      category: "SUPPLEMENT",
      net_unit_amount: it.netUnitAmountIdr,
      quantity: it.quantity,
      currency: "IDR",
    })),
    description: input.description,
    success_return_url: input.successReturnUrl,
    cancel_return_url: input.cancelReturnUrl,
  });
}

/**
 * Sesi SAVE — simpan/link ulang metode tanpa menagih (re-link wallet §7.6).
 * Hasil token datang lewat webhook payment_session.completed.
 */
export async function createSaveSession(input: {
  referenceId: string;
  customer: CreateSessionInput["customer"];
  successReturnUrl: string;
  cancelReturnUrl: string;
}): Promise<PaymentSession> {
  return xenditFetch<PaymentSession>("/sessions", {
    reference_id: input.referenceId,
    session_type: "SAVE",
    mode: "PAYMENT_LINK",
    country: "ID",
    currency: "IDR",
    amount: 0,
    channel_properties: {
      cards: { card_on_file_type: "RECURRING" },
    },
    customer: {
      reference_id: input.customer.referenceId,
      type: "INDIVIDUAL",
      email: input.customer.email,
      ...(input.customer.mobileNumber ? { mobile_number: input.customer.mobileNumber } : {}),
      individual_detail: {
        given_names: input.customer.givenNames,
        ...(input.customer.surname ? { surname: input.customer.surname } : {}),
      },
    },
    success_return_url: input.successReturnUrl,
    cancel_return_url: input.cancelReturnUrl,
  });
}

// ── Charge berulang: Payment Request v3 off-session (MIT) ────────────────────

export interface OffSessionChargeInput {
  referenceId: string; // = charges.idempotency_key — tulang punggung idempotensi
  paymentTokenId: string;
  amountIdr: number;
  metadata: { subscription_id: string; cycle: string; attempt: string };
}

export interface PaymentRequest {
  payment_request_id: string;
  reference_id: string;
  status: "SUCCEEDED" | "FAILED" | "REQUIRES_ACTION" | "AUTHORIZED" | "CANCELED" | "EXPIRED" | "ACCEPTING_PAYMENTS" | "PENDING";
  failure_code?: string;
}

export async function createOffSessionCharge(input: OffSessionChargeInput): Promise<PaymentRequest> {
  const midLabel = process.env.XENDIT_MID_LABEL;
  return xenditFetch<PaymentRequest>("/v3/payment_requests", {
    reference_id: input.referenceId,
    payment_token_id: input.paymentTokenId,
    type: "PAY",
    country: "ID",
    currency: "IDR",
    request_amount: input.amountIdr,
    capture_method: "AUTOMATIC",
    ...(midLabel ? { channel_properties: { mid_label: midLabel, card_on_file_type: "RECURRING" } } : {}),
    metadata: input.metadata,
  });
}

// ── Webhook ──────────────────────────────────────────────────────────────────

/** Verifikasi header x-callback-token, konstan-waktu. Panggil SEBELUM parsing body. */
export function verifyCallbackToken(headerValue: string | null): boolean {
  const expected = process.env.XENDIT_WEBHOOK_TOKEN;
  if (!expected || !headerValue) return false;
  const a = createHash("sha256").update(headerValue).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export type XenditWebhookEvent =
  | "payment.capture"
  | "payment.failure"
  | "payment.authorization"
  | "payment_session.completed"
  | "payment_token.activation"
  | "payment_token.failure"
  | "payment_token.expiry";

export interface XenditWebhookPayload {
  event: XenditWebhookEvent;
  business_id: string;
  created: string;
  data: {
    payment_id?: string;
    payment_request_id?: string;
    payment_token_id?: string;
    reference_id?: string;
    status?: string;
    failure_code?: string;
    channel_code?: string;
    [k: string]: unknown;
  };
}

// ── Klasifikasi kegagalan (§7.5) ─────────────────────────────────────────────
// ⚠️ Daftar failure_code resmi belum didapat dari Xendit (butir terbuka #1 di
// IMPLEMENTATION.md §16). Pemetaan di bawah KONSERVATIF: yang tidak dikenal
// dianggap retryable — gagal ke arah tidak-menagih tetap dijaga oleh jadwal
// dunning, bukan oleh charge ulang instan. Kode mentah selalu disimpan di
// charges.error_code untuk melengkapi tabel ini nanti.

export type FailureAction = "retry" | "token_dead" | "change_method" | "infra";

export function classifyFailure(failureCode: string | undefined, httpStatus?: number): FailureAction {
  if (httpStatus && httpStatus >= 500) return "infra"; // bukan attempt dunning
  const code = (failureCode || "").toUpperCase();
  if (/TOKEN|EXPIRED|REVOKED|UNLINKED|ACCOUNT_ACCESS/.test(code)) return "token_dead";
  if (/STOLEN|LOST|BLOCKED|INVALID_CARD|DO_NOT_HONOR_PERMANENT/.test(code)) return "change_method";
  return "retry"; // saldo kurang, decline sementara, unknown
}
