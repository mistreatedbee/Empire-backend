import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db';

const router = Router();

function requireSeedKey(req: Request, res: Response): boolean {
  const key = (req.body?.key as string) ?? (req.query?.key as string);
  if (!process.env.DEV_SEED_KEY || key !== process.env.DEV_SEED_KEY) {
    res.status(403).json({ code: 'FORBIDDEN', message: 'Invalid seed key.' });
    return false;
  }
  return true;
}

// POST /dev/seed-driver
router.post('/seed-driver', async (req: Request, res: Response) => {
  try {
    if (!requireSeedKey(req, res)) return;

    const email = 'driver@empiredeliveries.co.za';
    const phone = '+27800000001';
    const password = 'Driver123!';

    await pool.query('DELETE FROM users WHERE email = $1', [email]);
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users (first_name, last_name, email, phone, password_hash, role, is_verified)
       VALUES ($1, $2, $3, $4, $5, 'driver', true)`,
      ['Test', 'Driver', email, phone, hash]
    );

    res.json({ success: true, data: { email, phone, password, role: 'driver' } });
  } catch (err) {
    console.error('seed-driver error:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Seed failed.' });
  }
});

// POST /dev/seed  — seeds demo restaurant data
router.post('/seed', async (req: Request, res: Response) => {
  try {
    if (!requireSeedKey(req, res)) return;

    const client = await pool.connect();
    try {
      // Categories
      const cats = await client.query(`
        INSERT INTO categories (name, icon, slug) VALUES
          ('Fast Food', '🍔', 'fast-food'),
          ('Pizza', '🍕', 'pizza'),
          ('Healthy', '🥗', 'healthy'),
          ('Seafood', '🐟', 'seafood'),
          ('Groceries', '🛒', 'groceries'),
          ('Desserts', '🍰', 'desserts')
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, slug
      `);
      const catMap: Record<string, string> = {};
      for (const r of cats.rows) catMap[r.slug as string] = r.id as string;

      await seedNandos(client, catMap['fast-food']);
      await seedDebonairs(client, catMap['pizza']);
      await seedKauai(client, catMap['healthy']);
      await seedOceanBasket(client, catMap['seafood']);

      res.json({ success: true, data: { message: 'Demo data seeded successfully.' } });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('seed error:', err);
    res.status(500).json({ code: 'SERVER_ERROR', message: 'Seed failed.', detail: String(err) });
  }
});

export default router;

// ─── Seed helpers ─────────────────────────────────────────────────────────────

async function upsertRestaurant(client: import('pg').PoolClient, r: Record<string, unknown>) {
  const res = await client.query(`
    INSERT INTO restaurants (name, slug, description, cover_image, logo, category_id, rating, review_count,
      delivery_time_min, delivery_time_max, delivery_fee, min_order, is_open, is_featured, address, latitude, longitude)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (slug) DO UPDATE SET
      name=EXCLUDED.name, description=EXCLUDED.description, cover_image=EXCLUDED.cover_image,
      logo=EXCLUDED.logo, rating=EXCLUDED.rating, is_open=EXCLUDED.is_open, is_featured=EXCLUDED.is_featured
    RETURNING id
  `, [r.name, r.slug, r.description, r.cover_image, r.logo, r.category_id, r.rating, r.review_count,
      r.delivery_time_min, r.delivery_time_max, r.delivery_fee, r.min_order, r.is_open, r.is_featured,
      r.address, r.latitude, r.longitude]);
  return res.rows[0].id as string;
}

async function upsertMenuCat(client: import('pg').PoolClient, restaurantId: string, name: string, order: number) {
  const res = await client.query(`
    INSERT INTO menu_categories (restaurant_id, name, display_order) VALUES ($1,$2,$3)
    ON CONFLICT DO NOTHING RETURNING id
  `, [restaurantId, name, order]);
  if (res.rows.length) return res.rows[0].id as string;
  return (await client.query('SELECT id FROM menu_categories WHERE restaurant_id=$1 AND name=$2', [restaurantId, name])).rows[0].id as string;
}

async function upsertItem(client: import('pg').PoolClient, catId: string, restId: string, item: Record<string, unknown>) {
  const res = await client.query(`
    INSERT INTO menu_items (menu_category_id, restaurant_id, name, description, price, image, display_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id
  `, [catId, restId, item.name, item.description, item.price, item.image, item.display_order]);
  if (res.rows.length) return res.rows[0].id as string;
  return (await client.query('SELECT id FROM menu_items WHERE menu_category_id=$1 AND name=$2', [catId, item.name])).rows[0].id as string;
}

async function upsertGroup(client: import('pg').PoolClient, itemId: string, name: string, min: number, max: number, addons: { name: string; price: number }[]) {
  let gid: string;
  const ex = await client.query('SELECT id FROM addon_groups WHERE menu_item_id=$1 AND name=$2', [itemId, name]);
  if (ex.rows.length) {
    gid = ex.rows[0].id as string;
  } else {
    gid = (await client.query(`INSERT INTO addon_groups (menu_item_id, name, min_selections, max_selections) VALUES ($1,$2,$3,$4) RETURNING id`, [itemId, name, min, max])).rows[0].id as string;
  }
  for (const a of addons) {
    await client.query(`INSERT INTO addons (addon_group_id, name, price) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [gid, a.name, a.price]);
  }
}

async function seedNandos(client: import('pg').PoolClient, catId: string) {
  const id = await upsertRestaurant(client, {
    name: "Nando's", slug: 'nandos',
    description: "Flame-grilled PERi-PERi chicken, South Africa's favourite since 1987.",
    cover_image: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c5?w=800&q=80',
    logo: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c5?w=200&q=80',
    category_id: catId, rating: 4.5, review_count: 1284,
    delivery_time_min: 25, delivery_time_max: 40, delivery_fee: 35, min_order: 80,
    is_open: true, is_featured: true,
    address: '12 Sandton Drive, Sandton, Johannesburg', latitude: -26.1067, longitude: 28.0567,
  });
  const c1 = await upsertMenuCat(client, id, 'Chicken', 0);
  const c2 = await upsertMenuCat(client, id, 'Sides', 1);
  const c3 = await upsertMenuCat(client, id, 'Drinks', 2);
  const heat = [{ name: 'Lemon & Herb', price: 0 }, { name: 'Mild', price: 0 }, { name: 'Hot', price: 0 }, { name: 'Extra Hot', price: 0 }];
  const qc = await upsertItem(client, c1, id, { name: 'Quarter Chicken', description: 'Flame-grilled quarter chicken in your choice of PERi-PERi sauce.', price: 89, image: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c5?w=400&q=80', display_order: 0 });
  await upsertGroup(client, qc, 'PERi-PERi Heat', 1, 1, heat);
  const hc = await upsertItem(client, c1, id, { name: 'Half Chicken', description: 'Half flame-grilled PERi-PERi chicken with two sides.', price: 159, image: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c5?w=400&q=80', display_order: 1 });
  await upsertGroup(client, hc, 'PERi-PERi Heat', 1, 1, heat);
  await upsertItem(client, c1, id, { name: 'Chicken Strips (6)', description: 'Six tender strips marinated in PERi-PERi, served with a dip.', price: 109, image: 'https://images.unsplash.com/photo-1562967914-608f82629710?w=400&q=80', display_order: 2 });
  await upsertItem(client, c2, id, { name: 'PERi-PERi Chips', description: 'Crispy seasoned chips dusted with PERi-PERi spice.', price: 45, image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80', display_order: 0 });
  await upsertItem(client, c2, id, { name: 'Coleslaw', description: "Creamy homemade coleslaw, a Nando's classic.", price: 35, image: 'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=400&q=80', display_order: 1 });
  await upsertItem(client, c3, id, { name: 'Bottomless Soft Drink', description: 'Coke, Sprite, Fanta or Appletiser.', price: 38, image: 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=400&q=80', display_order: 0 });
}

async function seedDebonairs(client: import('pg').PoolClient, catId: string) {
  const id = await upsertRestaurant(client, {
    name: 'Debonairs Pizza', slug: 'debonairs',
    description: "SA's pizza pioneers. Triple-Decker, Dbl Decker & more.",
    cover_image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&q=80',
    logo: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=200&q=80',
    category_id: catId, rating: 4.2, review_count: 987,
    delivery_time_min: 30, delivery_time_max: 50, delivery_fee: 35, min_order: 100,
    is_open: true, is_featured: true,
    address: '45 Commissioner Street, Johannesburg CBD', latitude: -26.2041, longitude: 28.0473,
  });
  const c1 = await upsertMenuCat(client, id, 'Pizzas', 0);
  const c2 = await upsertMenuCat(client, id, 'Sides & Extras', 1);
  const sizes = [{ name: 'Small (23cm)', price: 0 }, { name: 'Medium (30cm)', price: 30 }, { name: 'Large (36cm)', price: 60 }];
  const mg = await upsertItem(client, c1, id, { name: 'Margherita', description: 'Classic tomato base, mozzarella, fresh basil.', price: 99, image: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400&q=80', display_order: 0 });
  await upsertGroup(client, mg, 'Size', 1, 1, sizes);
  const bb = await upsertItem(client, c1, id, { name: 'BBQ Chicken', description: 'BBQ base, grilled chicken strips, peppers and caramelised onion.', price: 129, image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400&q=80', display_order: 1 });
  await upsertGroup(client, bb, 'Size', 1, 1, sizes);
  const td = await upsertItem(client, c1, id, { name: 'Triple Decker', description: 'Three layers of pizza — double toppings, double cheese.', price: 179, image: 'https://images.unsplash.com/photo-1571407970349-bc81e7e96d47?w=400&q=80', display_order: 2 });
  await upsertGroup(client, td, 'Size', 1, 1, [{ name: 'Medium (30cm)', price: 0 }, { name: 'Large (36cm)', price: 40 }]);
  await upsertItem(client, c2, id, { name: 'Garlic Bread', description: 'Oven-fresh garlic bread with herb butter.', price: 39, image: 'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=400&q=80', display_order: 0 });
  await upsertItem(client, c2, id, { name: 'Loaded Potato Wedges', description: 'Thick-cut wedges with sour cream and sweet chilli.', price: 55, image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80', display_order: 1 });
}

async function seedKauai(client: import('pg').PoolClient, catId: string) {
  const id = await upsertRestaurant(client, {
    name: 'Kauai', slug: 'kauai',
    description: 'Fresh, wholesome food made with love. Wraps, smoothies, salads & more.',
    cover_image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&q=80',
    logo: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=200&q=80',
    category_id: catId, rating: 4.6, review_count: 743,
    delivery_time_min: 20, delivery_time_max: 35, delivery_fee: 35, min_order: 70,
    is_open: true, is_featured: false,
    address: 'Shop 12, Rosebank Mall, Johannesburg', latitude: -26.1461, longitude: 28.0436,
  });
  const c1 = await upsertMenuCat(client, id, 'Wraps & Rolls', 0);
  const c2 = await upsertMenuCat(client, id, 'Smoothies & Juices', 1);
  await upsertItem(client, c1, id, { name: 'Chicken Avocado Wrap', description: 'Grilled chicken, avo, mixed greens, tomato, honey mustard in a wholewheat wrap.', price: 89, image: 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=400&q=80', display_order: 0 });
  await upsertItem(client, c1, id, { name: 'Vegan Rainbow Bowl', description: 'Quinoa, roasted veggies, chickpeas, tahini dressing.', price: 99, image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&q=80', display_order: 1 });
  await upsertItem(client, c1, id, { name: 'Tuna & Avo Roll', description: 'Tuna mayo, sliced avo, cucumber and rocket in a freshly baked roll.', price: 79, image: 'https://images.unsplash.com/photo-1553909489-cd47e0907980?w=400&q=80', display_order: 2 });
  const sm = await upsertItem(client, c2, id, { name: 'Protein Shake', description: 'Vanilla or chocolate protein shake blended with banana and oat milk.', price: 65, image: 'https://images.unsplash.com/photo-1553530666-ba11a7da3888?w=400&q=80', display_order: 0 });
  await upsertGroup(client, sm, 'Flavour', 1, 1, [{ name: 'Vanilla', price: 0 }, { name: 'Chocolate', price: 0 }, { name: 'Strawberry', price: 0 }]);
  await upsertItem(client, c2, id, { name: 'Green Detox Juice', description: 'Spinach, cucumber, green apple, ginger and lemon.', price: 55, image: 'https://images.unsplash.com/photo-1615485290382-441e4d049cb5?w=400&q=80', display_order: 1 });
}

async function seedOceanBasket(client: import('pg').PoolClient, catId: string) {
  const id = await upsertRestaurant(client, {
    name: 'Ocean Basket', slug: 'ocean-basket',
    description: 'Fresh seafood, Mediterranean style. Prawns, calamari, fish and more.',
    cover_image: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800&q=80',
    logo: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=200&q=80',
    category_id: catId, rating: 4.4, review_count: 612,
    delivery_time_min: 35, delivery_time_max: 55, delivery_fee: 45, min_order: 120,
    is_open: true, is_featured: true,
    address: '203 Oxford Road, Illovo, Johannesburg', latitude: -26.1309, longitude: 28.0478,
  });
  const c1 = await upsertMenuCat(client, id, 'Mains', 0);
  const c2 = await upsertMenuCat(client, id, 'Starters', 1);
  await upsertItem(client, c1, id, { name: 'Calamari (300g)', description: 'Tender calamari tubes lightly crumbed and fried, served with tartare sauce.', price: 139, image: 'https://images.unsplash.com/photo-1609501676725-7186f017a4b7?w=400&q=80', display_order: 0 });
  const pr = await upsertItem(client, c1, id, { name: 'Mozambican Prawns (500g)', description: 'Shell-on prawns in a rich, buttery Mozambican sauce with peri-peri.', price: 219, image: 'https://images.unsplash.com/photo-1565680018434-b513d5e5fd47?w=400&q=80', display_order: 1 });
  await upsertGroup(client, pr, 'Sauce', 1, 1, [{ name: 'Mozambican', price: 0 }, { name: 'Garlic Butter', price: 0 }, { name: 'Lemon Butter', price: 0 }]);
  await upsertItem(client, c1, id, { name: 'Linefish of the Day', description: 'Fresh catch, grilled or fried, served with chips and salad.', price: 169, image: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=400&q=80', display_order: 2 });
  await upsertItem(client, c2, id, { name: 'Calamari Heads', description: 'Crispy fried calamari heads — a classic starter.', price: 79, image: 'https://images.unsplash.com/photo-1609501676725-7186f017a4b7?w=400&q=80', display_order: 0 });
  await upsertItem(client, c2, id, { name: 'Garlic Bread with Cheese', description: 'Toasted garlic bread topped with melted mozzarella.', price: 49, image: 'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=400&q=80', display_order: 1 });
}
