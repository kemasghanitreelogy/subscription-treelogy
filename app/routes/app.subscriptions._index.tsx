// "Contracts" versi kita — daftar semua langganan dengan filter status &
// pencarian. Pengganti daftar contract app Subscriptions native (ADR-01).
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { pooledDb } from "../db/client.server";

const STATUS_TONE: Record<string, "success" | "warning" | "neutral" | "critical"> = {
  active: "success",
  dunning: "warning",
  paused: "neutral",
  cancelled: "critical",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const q = url.searchParams.get("q") ?? "";

  const where: string[] = [];
  const params: unknown[] = [];
  if (["active", "dunning", "paused", "cancelled"].includes(status)) {
    params.push(status);
    where.push(`status = $${params.length}::subscription_status`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`lower(email) like $${params.length}`);
  }

  const db = pooledDb();
  const { rows } = await db.query(
    `select id, email, status, frequency_days, next_charge_date, cycle_count,
            payment_method, quantity,
            (unit_amount_idr * quantity) + shipping_amount_idr as total_idr,
            created_at
       from subscriptions
      ${where.length ? `where ${where.join(" and ")}` : ""}
      order by created_at desc
      limit 100`,
    params,
  );
  const { rows: counts } = await db.query<{ status: string; n: number }>(
    "select status, count(*)::int as n from subscriptions group by status",
  );
  const byStatus: Record<string, number> = {};
  for (const c of counts) byStatus[c.status] = c.n;
  return { subs: rows, byStatus, status, q };
};

const rupiah = (n: number) => `Rp${Number(n).toLocaleString("id-ID")}`;

export default function Subscriptions() {
  const { subs, byStatus, status, q } = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();

  const tab = (value: string, label: string) => (
    <s-button
      variant={status === value ? "primary" : "secondary"}
      onClick={() => setSearchParams(value ? { status: value } : {})}
    >
      {`${label}${value && byStatus[value] ? ` (${byStatus[value]})` : ""}`}
    </s-button>
  );

  return (
    <s-page heading="Langganan">
      <s-section padding="none" accessibilityLabel="Daftar langganan">
        <s-box padding="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            {tab("", "Semua")}
            {tab("active", "Aktif")}
            {tab("dunning", "Dunning")}
            {tab("paused", "Paused")}
            {tab("cancelled", "Cancelled")}
            <s-search-field
              label="Cari email"
              labelAccessibilityVisibility="exclusive"
              placeholder="Cari email…"
              defaultValue={q}
              onChange={(e: Event) =>
                setSearchParams(
                  (e.target as HTMLInputElement).value
                    ? { ...(status ? { status } : {}), q: (e.target as HTMLInputElement).value }
                    : status
                      ? { status }
                      : {},
                )
              }
            />
          </s-stack>
        </s-box>

        {subs.length === 0 ? (
          <s-box padding="large">
            <s-stack direction="block" gap="base" alignItems="center">
              <s-heading>Belum ada langganan</s-heading>
              <s-paragraph color="subdued">
                Langganan muncul di sini begitu pelanggan pertama subscribe lewat widget produk.
              </s-paragraph>
            </s-stack>
          </s-box>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Pelanggan</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header>Frekuensi</s-table-header>
              <s-table-header>Tagihan berikutnya</s-table-header>
              <s-table-header format="numeric">Siklus</s-table-header>
              <s-table-header listSlot="labeled" format="currency">Total/siklus</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {subs.map((s: { id: string; email: string; status: string; frequency_days: number; next_charge_date: string | null; cycle_count: number; total_idr: number }) => (
                <s-table-row key={s.id}>
                  <s-table-cell>
                    <s-link href={`/app/subscriptions/${s.id}`}>{s.email}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[s.status] ?? "neutral"}>{s.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>tiap {s.frequency_days} hari</s-table-cell>
                  <s-table-cell>{s.next_charge_date ?? "—"}</s-table-cell>
                  <s-table-cell>{String(s.cycle_count)}</s-table-cell>
                  <s-table-cell>{rupiah(s.total_idr)}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
