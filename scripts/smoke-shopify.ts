// Uji jalur Admin API app (session offline di shopify_sessions).
// Jalankan: npx tsx --env-file=.env scripts/smoke-shopify.ts
import { getProductByHandle, findCustomerGidByEmail } from "../app/services/shopify-order.server";

const handle = process.argv[2] ?? "organic-moringa-capsules";
const p = await getProductByHandle(handle);
if (!p) {
  console.error(`✗ produk '${handle}' tidak ditemukan`);
  process.exit(1);
}
console.log(`✓ produk: ${p.title} | varian: ${p.variants.edges.length}`);
for (const e of p.variants.edges) {
  console.log(`  - ${e.node.title} · Rp${Math.round(Number(e.node.price)).toLocaleString("id-ID")} · ${e.node.availableForSale ? "tersedia" : "habis"}`);
}
const gid = await findCustomerGidByEmail("kemas@treelogy.com");
console.log(`✓ lookup customer by email jalan (hasil: ${gid ?? "tidak ada"})`);
process.exit(0);
