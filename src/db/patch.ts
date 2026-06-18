import { pool } from './index';

// ──────────────────────────────────────────────────────────────────────────────
// RLS statements are DDL and run inside a transaction fine.
// CREATE INDEX (without CONCURRENTLY) also runs inside a transaction.
// Superusers (postgres) bypass RLS even after FORCE — backend behaviour is
// unchanged. These changes block direct PostgREST anon-key access only.
//
// Also widens otps.phone to TEXT so it can hold email addresses (phone → email
// identifier migration — OTP now verified by email not SMS).
// ──────────────────────────────────────────────────────────────────────────────

const SCHEMA_PATCHES = [
  // Widen otps.phone so it can store email addresses (up to 320 chars)
  `ALTER TABLE public.otps ALTER COLUMN phone TYPE TEXT`,
  // Add approval_status + suspension_reason to users if not already present
  `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) NOT NULL DEFAULT 'approved'`,
  `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS suspension_reason TEXT`,
];

const RLS_TABLES = [
  'otps',
  'refresh_tokens',
  'password_reset_tokens',
  'users',
  'restaurants',
  'categories',
  'menu_categories',
  'menu_items',
  'addon_groups',
  'addons',
  'user_addresses',
  'orders',
  'order_items',
  'coupons',
  'favourites',
  'restaurant_reviews',
  'notifications',
  'push_tokens',
  'drivers',
  'driver_transactions',
  'driver_assignments',
  'wallet_transactions',
  'withdrawal_requests',
  'driver_documents',
];

const FK_INDEXES: Array<{ name: string; table: string; column: string }> = [
  { name: 'idx_refresh_tokens_user_id',          table: 'refresh_tokens',       column: 'user_id' },
  { name: 'idx_password_reset_tokens_user_id',   table: 'password_reset_tokens',column: 'user_id' },
  { name: 'idx_restaurants_owner_id',            table: 'restaurants',           column: 'owner_id' },
  { name: 'idx_menu_categories_restaurant_id',   table: 'menu_categories',       column: 'restaurant_id' },
  { name: 'idx_menu_items_menu_category_id',     table: 'menu_items',            column: 'menu_category_id' },
  { name: 'idx_addon_groups_menu_item_id',       table: 'addon_groups',          column: 'menu_item_id' },
  { name: 'idx_addons_addon_group_id',           table: 'addons',                column: 'addon_group_id' },
  { name: 'idx_orders_delivery_address_id',      table: 'orders',                column: 'delivery_address_id' },
  { name: 'idx_orders_driver_id',                table: 'orders',                column: 'driver_id' },
  { name: 'idx_orders_restaurant_id',            table: 'orders',                column: 'restaurant_id' },
  { name: 'idx_order_items_menu_item_id',        table: 'order_items',           column: 'menu_item_id' },
  { name: 'idx_order_items_order_id',            table: 'order_items',           column: 'order_id' },
  { name: 'idx_favourites_restaurant_id',        table: 'favourites',            column: 'restaurant_id' },
  { name: 'idx_restaurant_reviews_order_id',     table: 'restaurant_reviews',    column: 'order_id' },
  { name: 'idx_driver_assignments_driver_id',    table: 'driver_assignments',    column: 'driver_id' },
  { name: 'idx_driver_transactions_driver_id',   table: 'driver_transactions',   column: 'driver_id' },
  { name: 'idx_driver_transactions_order_id',    table: 'driver_transactions',   column: 'order_id' },
  { name: 'idx_wallet_transactions_user_id',     table: 'wallet_transactions',   column: 'user_id' },
  { name: 'idx_withdrawal_requests_driver_id',   table: 'withdrawal_requests',   column: 'driver_id' },
];

async function patch() {
  const client = await pool.connect();
  let rlsOk = 0;
  let idxOk = 0;

  try {
    await client.query('BEGIN');

    // ── Section 0: Schema patches ─────────────────────────────────────────────
    for (const sql of SCHEMA_PATCHES) {
      try {
        await client.query(sql);
        console.log(`  ✓ Schema patch — ${sql.slice(0, 60)}…`);
      } catch (err: any) {
        console.warn(`  ⚠ Schema patch skipped — ${err.message}`);
      }
    }

    // ── Section 1: Row Level Security (24 tables) ─────────────────────────────
    for (const table of RLS_TABLES) {
      try {
        await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
        rlsOk++;
        console.log(`  ✓ RLS enabled  — ${table}`);
      } catch (err: any) {
        // Table may not exist yet in this environment — skip and warn
        console.warn(`  ⚠ Skipped RLS  — ${table}: ${err.message}`);
      }
    }

    // ── Section 2: Missing FK indexes (19) ───────────────────────────────────
    for (const { name, table, column } of FK_INDEXES) {
      try {
        await client.query(
          `CREATE INDEX IF NOT EXISTS ${name} ON public.${table}(${column})`
        );
        idxOk++;
        console.log(`  ✓ Index created — ${name}`);
      } catch (err: any) {
        console.warn(`  ⚠ Skipped index — ${name}: ${err.message}`);
      }
    }

    await client.query('COMMIT');
    console.log(`\nPatch complete. RLS: ${rlsOk}/${RLS_TABLES.length} tables, Indexes: ${idxOk}/${FK_INDEXES.length} created.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Patch failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

patch();
