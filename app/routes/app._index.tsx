// Dashboard internal (embedded di Shopify admin). Langganan TIDAK muncul di
// admin Shopify sebagai objek langganan (ADR-01) — halaman ini penggantinya.
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { pooledDb } from "../db/client.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const db = pooledDb();

  const [counts, orphaned, heartbeat, recent] = await Promise.all([
    db.query(`select status, count(*)::int as n, coalesce(sum((unit_amount_idr * quantity) + shipping_amount_idr) filter (where status in ('active','dunning')), 0)::bigint as revenue
                from subscriptions group by status`),
    db.query(`select count(*)::int as n from charges
               where status = 'succeeded' and shopify_order_gid is null
                 and settled_at < now() - interval '2 minutes'`),
    db.query(`select worker_name, last_tick_at, claimed_count from worker_heartbeat
               where worker_name = 'worker' limit 1`),
    db.query(`select id, email, status, frequency_days, next_charge_date, cycle_count, payment_method,
                     (unit_amount_idr * quantity) + shipping_amount_idr as total_idr
                from subscriptions order by created_at desc limit 25`),
  ]);

  const byStatus: Record<string, number> = {};
  let cycleRevenue = 0;
  for (const row of counts.rows) {
    byStatus[row.status] = row.n;
    cycleRevenue += Number(row.revenue ?? 0);
  }
  const hb = heartbeat.rows[0] ?? null;
  const heartbeatStaleMinutes = hb
    ? Math.round((Date.now() - new Date(hb.last_tick_at).getTime()) / 60000)
    : null;

  return {
    byStatus,
    cycleRevenue,
    orphanedCount: orphaned.rows[0].n,
    heartbeatStaleMinutes,
    recent: recent.rows,
  };
};

const rupiah = (n: number) => `Rp${Number(n).toLocaleString("id-ID")}`;

export default function Index() {
  const { byStatus, cycleRevenue, orphanedCount, heartbeatStaleMinutes, recent } =
    useLoaderData<typeof loader>();

  const heartbeatBad = heartbeatStaleMinutes === null || heartbeatStaleMinutes > 15;

  return (
    <s-page>
      <ui-title-bar title="Treelogy Subscriptions" />

      {orphanedCount > 0 && (
        <s-banner tone="critical" heading="P1 — charge sukses tanpa order">
          {orphanedCount} charge sudah menarik uang tetapi order Shopify belum terbentuk lebih dari 2 menit.
          Job rekonsiliasi sedang mencoba; kalau bertahan &gt;10 menit, tangani manual (runbook §14).
        </s-banner>
      )}
      {heartbeatBad && (
        <s-banner tone="warning" heading="Heartbeat worker basi">
          {heartbeatStaleMinutes === null
            ? "Worker belum pernah menulis heartbeat."
            : `Tick terakhir ${heartbeatStaleMinutes} menit lalu (ambang 15).`}{" "}
          Cek `fly status` dan log worker.
        </s-banner>
      )}

      <s-section heading="Ringkasan">
        <s-stack direction="inline" gap="base">
          <s-box padding="base"><s-heading>{String(byStatus.active ?? 0)}</s-heading><s-text>aktif</s-text></s-box>
          <s-box padding="base"><s-heading>{String(byStatus.dunning ?? 0)}</s-heading><s-text>dunning</s-text></s-box>
          <s-box padding="base"><s-heading>{String(byStatus.paused ?? 0)}</s-heading><s-text>paused</s-text></s-box>
          <s-box padding="base"><s-heading>{String(byStatus.cancelled ?? 0)}</s-heading><s-text>cancelled</s-text></s-box>
          <s-box padding="base"><s-heading>{rupiah(cycleRevenue)}</s-heading><s-text>nilai per siklus (aktif+dunning)</s-text></s-box>
        </s-stack>
      </s-section>

      <s-section heading="Langganan terbaru">
        <s-table>
          <s-table-header-row>
            <s-table-header>Email</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Frekuensi</s-table-header>
            <s-table-header>Tagihan berikutnya</s-table-header>
            <s-table-header>Siklus</s-table-header>
            <s-table-header>Metode</s-table-header>
            <s-table-header>Total/siklus</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {recent.map((s: { id: string; email: string; status: string; frequency_days: number; next_charge_date: string | null; cycle_count: number; payment_method: string; total_idr: number }) => (
              <s-table-row key={s.id}>
                <s-table-cell>{s.email}</s-table-cell>
                <s-table-cell>{s.status}</s-table-cell>
                <s-table-cell>tiap {s.frequency_days} hari</s-table-cell>
                <s-table-cell>{s.next_charge_date ?? "—"}</s-table-cell>
                <s-table-cell>{String(s.cycle_count)}</s-table-cell>
                <s-table-cell>{s.payment_method}</s-table-cell>
                <s-table-cell>{rupiah(s.total_idr)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
