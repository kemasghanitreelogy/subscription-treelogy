// Membuat order Shopify setelah charge Xendit TERKONFIRMASI sukses (webhook).
// financialStatus PAID = pernyataan uang sudah benar-benar diterima — jangan
// pernah panggil ini sebelum webhook masuk (IMPLEMENTATION.md §6.2).
import { unauthenticated, STORE_NAME } from "../shopify.server";

const ORDER_CREATE = `#graphql
  mutation CreateRenewalOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
        displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const METAFIELDS_SET = `#graphql
  mutation RecordChargeReference($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key namespace value }
      userErrors { field message code }
    }
  }
`;

export interface CreateSubscriptionOrderInput {
  variantGid: string;
  quantity: number;
  email: string;
  isFirstCycle: boolean;
  xenditChargeId: string;
  subscriptionId: string;
  cycle: string; // scheduled_for WIB
}

export async function createSubscriptionOrder(input: CreateSubscriptionOrderInput): Promise<string> {
  if (!STORE_NAME) throw new Error("STORE_NAME wajib diisi");
  const { admin } = await unauthenticated.admin(STORE_NAME);

  const res = await admin.graphql(ORDER_CREATE, {
    variables: {
      order: {
        lineItems: [{ variantId: input.variantGid, quantity: input.quantity }],
        customer: { toUpsert: { email: input.email } },
        financialStatus: "PAID",
        tags: ["subscription", input.isFirstCycle ? "subscription-first" : "subscription-renewal"],
        note: `Xendit charge ${input.xenditChargeId} · siklus ${input.cycle}`,
      },
    },
  });
  const json = await res.json();
  const payload = json.data?.orderCreate;
  if (!payload || payload.userErrors?.length) {
    throw new Error(`orderCreate gagal: ${JSON.stringify(payload?.userErrors ?? "tanpa data")}`);
  }
  const orderGid: string = payload.order.id;

  // Referensi charge sebagai metafield — rekonsiliasi keuangan tanpa buka database.
  const mfRes = await admin.graphql(METAFIELDS_SET, {
    variables: {
      metafields: [
        { ownerId: orderGid, namespace: "treelogy_sub", key: "xendit_charge_id", type: "single_line_text_field", value: input.xenditChargeId },
        { ownerId: orderGid, namespace: "treelogy_sub", key: "subscription_id", type: "single_line_text_field", value: input.subscriptionId },
        { ownerId: orderGid, namespace: "treelogy_sub", key: "cycle", type: "date", value: input.cycle },
      ],
    },
  });
  const mfJson = await mfRes.json();
  const mfErrors = mfJson.data?.metafieldsSet?.userErrors;
  if (mfErrors?.length) {
    // Order sudah jadi; metafield gagal tidak boleh membatalkan siklus — log saja.
    console.error("[shopify-order] metafieldsSet userErrors", mfErrors);
  }

  return orderGid;
}

/** Ambil produk by handle untuk halaman subscribe express-flow. */
export async function getProductByHandle(handle: string) {
  if (!STORE_NAME) throw new Error("STORE_NAME wajib diisi");
  const { admin } = await unauthenticated.admin(STORE_NAME);
  const res = await admin.graphql(
    `#graphql
    query ProductByHandle($handle: String!) {
      productByIdentifier(identifier: { handle: $handle }) {
        id
        title
        handle
        variants(first: 20) {
          edges { node { id title price availableForSale } }
        }
      }
    }`,
    { variables: { handle } },
  );
  const json = await res.json();
  return json.data?.productByIdentifier ?? null;
}

/** Cari customer gid by email — untuk mengikat langganan ke akun Shopify. */
export async function findCustomerGidByEmail(email: string): Promise<string | null> {
  if (!STORE_NAME) throw new Error("STORE_NAME wajib diisi");
  const { admin } = await unauthenticated.admin(STORE_NAME);
  const res = await admin.graphql(
    `#graphql
    query CustomerByEmail($query: String!) {
      customers(first: 1, query: $query) {
        edges { node { id } }
      }
    }`,
    { variables: { query: `email:${JSON.stringify(email)}` } },
  );
  const json = await res.json();
  return json.data?.customers?.edges?.[0]?.node?.id ?? null;
}

/** Ambil info varian (judul + harga) untuk halaman subscribe & validasi. */
export async function getVariant(variantGid: string) {
  if (!STORE_NAME) throw new Error("STORE_NAME wajib diisi");
  const { admin } = await unauthenticated.admin(STORE_NAME);
  const res = await admin.graphql(
    `#graphql
    query Variant($id: ID!) {
      productVariant(id: $id) {
        id
        title
        price
        product { id title handle }
      }
    }`,
    { variables: { id: variantGid } },
  );
  const json = await res.json();
  return json.data?.productVariant ?? null;
}
