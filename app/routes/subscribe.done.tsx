// Halaman kembali dari Xendit. JANGAN percaya URL ini sebagai bukti bayar
// (§5.2) — kebenaran hanya dari webhook. Halaman ini polling status charge.
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator } from "react-router";
import { useEffect } from "react";
import { pooledDb } from "../db/client.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const sid = new URL(request.url).searchParams.get("sid");
  if (!sid || !/^[0-9a-f-]{36}$/.test(sid)) throw new Response("Not found", { status: 404 });
  const db = pooledDb();
  const { rows } = await db.query(
    `select status from charges where subscription_id = $1 order by created_at desc limit 1`,
    [sid],
  );
  return { status: rows[0]?.status ?? "pending" };
};

export default function SubscribeDone() {
  const { status } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  useEffect(() => {
    if (status === "pending") {
      const t = setInterval(() => revalidator.revalidate(), 3000);
      return () => clearInterval(t);
    }
  }, [status, revalidator]);

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "system-ui", padding: "0 1rem", textAlign: "center" }}>
      {status === "succeeded" && (
        <>
          <h1>Langganan aktif 🎉</h1>
          <p>Pembayaran diterima. Detail lengkap dikirim ke email/WA kamu.</p>
        </>
      )}
      {status === "pending" && (
        <>
          <h1>Sedang memproses…</h1>
          <p>Menunggu konfirmasi pembayaran. Halaman ini akan diperbarui otomatis.</p>
        </>
      )}
      {(status === "failed" || status === "abandoned") && (
        <>
          <h1>Pembayaran belum berhasil</h1>
          <p>Tidak ada dana yang ditarik. Silakan coba lagi dari halaman produk.</p>
        </>
      )}
    </main>
  );
}
