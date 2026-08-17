import { pool } from '../db';

export interface ResolvedAddon {
  id: string;
  name: string;
  price: number;
}

/**
 * order_items.addon_ids is stored as a JSONB array of addon UUIDs — every order
 * detail endpoint (customer tracking, restaurant orders list, driver active
 * delivery) needs those resolved into { id, name, price } to actually show what
 * a customer customized on an item. Resolves all items' addon ids in a single
 * query and returns them in the same order as the input array.
 */
export async function resolveAddonsForItems(
  items: Array<{ addon_ids: unknown }>
): Promise<ResolvedAddon[][]> {
  const idSet = new Set<string>();
  for (const item of items) {
    const ids = Array.isArray(item.addon_ids) ? item.addon_ids : [];
    for (const id of ids) idSet.add(String(id));
  }
  if (!idSet.size) return items.map(() => []);

  const rows = await pool.query(
    `SELECT id, name, price FROM addons WHERE id = ANY($1::uuid[])`,
    [Array.from(idSet)]
  );
  const byId = new Map(
    rows.rows.map((r) => [
      r.id as string,
      { id: r.id as string, name: r.name as string, price: parseFloat(String(r.price)) },
    ])
  );

  return items.map((item) => {
    const ids = Array.isArray(item.addon_ids) ? (item.addon_ids as string[]) : [];
    return ids
      .map((id) => byId.get(String(id)))
      .filter((a): a is ResolvedAddon => Boolean(a));
  });
}
