// Detail langganan + aksi admin (skip/pause/resume/cancel). Setiap aksi
// tercatat di events dengan actor 'admin:<shop>' — jawaban saat pelanggan
// protes "siapa yang mengubah langganan saya" (§11.2).
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { pooledDb } from "../db/client.server";
import {
  cancelSubscription,
  changeFrequency,
  pauseSubscription,
  rescheduleSubscription,
  resumeSubscription,
  skipCycle,
  type SubscriptionRow,
} from "../services/subscription-lifecycle.server";
import { PolicyViolation } from "../services/schedule.server";

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "critical"> = {
  active: "success",
  dunning: "warning",
  paused: "neutral",
  cancelled: "critical",
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const db = pooledDb();
  const [sub, charges, events] = await Promise.all([
    db.query("select * from subscriptions where id = $1", [params.id]),
    db.query(
      `select scheduled_for, attempt_n, status, amount_idr, error_code, shopify_order_gid, attempted_at
         from charges where subscription_id = $1 order by scheduled_for desc, attempt_n desc limit 30`,
      [params.id],
    ),
    db.query(
      `select type, actor, data, created_at from events
        where subscription_id = $1 order by created_at desc limit 30`,
      [params.id],
    ),
  ]);
  if (!sub.rows.length) throw new Response("Tidak ditemukan", { status: 404 });
  return { sub: sub.rows[0], charges: charges.rows, events: events.rows };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const actor = `admin:${session.shop}`;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  const db = pooledDb();
  const { rows } = await db.query("select * from subscriptions where id = $1", [params.id]);
  if (!rows.length) return Response.json({ error: "Tidak ditemukan" }, { status: 404 });
  const sub = rows[0] as SubscriptionRow;

  try {
    switch (intent) {
      case "skip": {
        const d = await skipCycle(db, sub, actor);
        return Response.json({ ok: true, message: `Siklus dilewati — tagihan berikutnya ${d}` });
      }
      case "pause":
        await pauseSubscription(db, sub, 1, actor);
        return Response.json({ ok: true, message: "Langganan dijeda" });
      case "resume": {
        const d = await resumeSubscription(db, sub, actor);
        return Response.json({ ok: true, message: `Aktif kembali — tagihan pertama ${d} (jaminan H-3)` });
      }
      case "cancel":
        await cancelSubscription(db, sub, String(form.get("reason") ?? "admin") || "admin", actor);
        return Response.json({ ok: true, message: "Langganan dibatalkan" });
      case "reschedule": {
        const d = await rescheduleSubscription(db, sub, String(form.get("date") ?? ""), actor);
        return Response.json({ ok: true, message: `Tagihan berikutnya digeser ke ${d}` });
      }
      case "frequency": {
        const days = Number(form.get("frequencyDays") ?? 0);
        if (![30, 60, 90].includes(days)) {
          return Response.json({ error: "Frekuensi harus 30/60/90 hari" }, { status: 400 });
        }
        const d = await changeFrequency(db, sub, days, actor);
        return Response.json({ ok: true, message: `Frekuensi jadi tiap ${days} hari — tagihan berikutnya ${d}` });
      }
      default:
        return Response.json({ error: "Aksi tidak dikenal" }, { status: 400 });
    }
  } catch (err) {
    const status = err instanceof PolicyViolation ? 422 : 400;
    return Response.json({ error: err instanceof Error ? err.message : "Gagal" }, { status });
  }
};

const rupiah = (n: number) => `Rp${Number(n).toLocaleString("id-ID")}`;

export default function SubscriptionDetail() {
  const { sub, charges, events } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok?: boolean; message?: string; error?: string }>();
  const busy = fetcher.state !== "idle";
  const act = (intent: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.set("intent", intent);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <s-page heading={sub.email}>
      <s-button slot="primary-action" variant="primary" disabled={busy || sub.status !== "active"} onClick={() => act("skip")}>
        Lewati 1 siklus
      </s-button>
      {sub.status === "paused" ? (
        <s-button slot="secondary-actions" disabled={busy} onClick={() => act("resume")}>Resume</s-button>
      ) : (
        <s-button slot="secondary-actions" disabled={busy || sub.status === "cancelled"} onClick={() => act("pause")}>Pause</s-button>
      )}
      <s-button slot="secondary-actions" tone="critical" disabled={busy || sub.status === "cancelled"} onClick={() => act("cancel", { reason: "admin" })}>
        Batalkan
      </s-button>

      {fetcher.data?.ok && <s-banner tone="success" heading={fetcher.data.message ?? "Beres"} dismissible></s-banner>}
      {fetcher.data?.error && <s-banner tone="critical" heading={fetcher.data.error} dismissible></s-banner>}

      <s-section heading="Ringkasan">
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-box>
            <s-paragraph color="subdued">Status</s-paragraph>
            <s-badge tone={STATUS_TONE[sub.status] ?? "neutral"}>{sub.status}</s-badge>
          </s-box>
          <s-box>
            <s-paragraph color="subdued">Frekuensi</s-paragraph>
            <s-text>tiap {sub.frequency_days} hari</s-text>
          </s-box>
          <s-box>
            <s-paragraph color="subdued">Tagihan berikutnya</s-paragraph>
            <s-text>{sub.next_charge_date ?? "—"}</s-text>
          </s-box>
          <s-box>
            <s-paragraph color="subdued">Total per siklus</s-paragraph>
            <s-text>{rupiah(sub.unit_amount_idr * sub.quantity + sub.shipping_amount_idr)}</s-text>
          </s-box>
          <s-box>
            <s-paragraph color="subdued">Metode bayar</s-paragraph>
            <s-text>{sub.payment_method}{sub.xendit_token_id ? "" : " (token belum terhubung)"}</s-text>
          </s-box>
          <s-box>
            <s-paragraph color="subdued">Siklus selesai</s-paragraph>
            <s-text>{String(sub.cycle_count)}</s-text>
          </s-box>
        </s-grid>
      </s-section>

      {sub.status === "active" && (
        <s-section heading="Ubah jadwal">
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-stack direction="block" gap="small-200">
              <s-date-field
                id="reschedule-date"
                label="Geser tagihan berikutnya ke"
                name="date"
                value={sub.next_charge_date ?? ""}
                details="Minimal 3 hari dari hari ini — jaminan pengingat H-3"
              ></s-date-field>
              <s-button
                disabled={busy}
                onClick={() =>
                  act("reschedule", {
                    date: (document.getElementById("reschedule-date") as HTMLInputElement).value,
                  })
                }
              >
                Geser tanggal
              </s-button>
            </s-stack>
            <s-stack direction="block" gap="small-200">
              <s-select id="frequency-select" label="Frekuensi" value={String(sub.frequency_days)}>
                <s-option value="30">Tiap 30 hari</s-option>
                <s-option value="60">Tiap 60 hari</s-option>
                <s-option value="90">Tiap 90 hari</s-option>
              </s-select>
              <s-button
                disabled={busy}
                onClick={() =>
                  act("frequency", {
                    frequencyDays: (document.getElementById("frequency-select") as HTMLSelectElement).value,
                  })
                }
              >
                Ubah frekuensi
              </s-button>
            </s-stack>
          </s-grid>
        </s-section>
      )}

      <s-section heading="Riwayat tagihan" padding="none">
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Siklus</s-table-header>
            <s-table-header format="numeric">Percobaan</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header listSlot="labeled" format="currency">Jumlah</s-table-header>
            <s-table-header>Order</s-table-header>
            <s-table-header>Error</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {charges.map((c: { scheduled_for: string; attempt_n: number; status: string; amount_idr: number; error_code: string | null; shopify_order_gid: string | null }) => (
              <s-table-row key={`${c.scheduled_for}-${c.attempt_n}`}>
                <s-table-cell>{c.scheduled_for}</s-table-cell>
                <s-table-cell>{String(c.attempt_n)}</s-table-cell>
                <s-table-cell>
                  <s-badge tone={c.status === "succeeded" ? "success" : c.status === "failed" ? "critical" : "neutral"}>
                    {c.status}
                  </s-badge>
                </s-table-cell>
                <s-table-cell>{rupiah(c.amount_idr)}</s-table-cell>
                <s-table-cell>
                  {c.shopify_order_gid ? (
                    <s-link href={`shopify://admin/orders/${c.shopify_order_gid.split("/").pop()}`}>Lihat order</s-link>
                  ) : (
                    "—"
                  )}
                </s-table-cell>
                <s-table-cell>{c.error_code ?? "—"}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Audit trail">
        <s-unordered-list>
          {events.map((e: { type: string; actor: string; created_at: string }, i: number) => (
            <s-list-item key={i}>
              {new Date(e.created_at).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} · <s-text type="strong">{e.type}</s-text> · {e.actor}
            </s-list-item>
          ))}
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
