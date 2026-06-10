import { pool } from './index';

async function seed() {
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

    // ─── Nando's ──────────────────────────────────────────────────────
    const nandos = await upsertRestaurant(client, {
      name: "Nando's",
      slug: 'nandos',
      description: "Flame-grilled PERi-PERi chicken, South Africa's favourite since 1987.",
      cover_image: 'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=800&q=80',
      logo: 'https://upload.wikimedia.org/wikipedia/en/thumb/4/47/Nandos-logo.svg/320px-Nandos-logo.svg.png',
      category_id: catMap['fast-food'],
      rating: 4.5,
      review_count: 1284,
      delivery_time_min: 25,
      delivery_time_max: 40,
      delivery_fee: 35,
      min_order: 80,
      is_open: true,
      is_featured: true,
      address: '12 Sandton Drive, Sandton, Johannesburg',
      latitude: -26.1067,
      longitude: 28.0567,
    });

    const nCat1 = await upsertMenuCategory(client, nandos, 'Chicken', 0);
    const nCat2 = await upsertMenuCategory(client, nandos, 'Sides', 1);
    const nCat3 = await upsertMenuCategory(client, nandos, 'Drinks', 2);

    const quarterChicken = await upsertMenuItem(client, nCat1, nandos, {
      name: 'Quarter Chicken',
      description: 'Flame-grilled quarter chicken basted in your choice of PERi-PERi sauce.',
      price: 89,
      image: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c5?w=400&q=80',
      display_order: 0,
    });
    await upsertAddonGroup(client, quarterChicken, 'PERi-PERi Heat', 1, 1, [
      { name: 'Lemon & Herb', price: 0 },
      { name: 'Mild', price: 0 },
      { name: 'Hot', price: 0 },
      { name: 'Extra Hot', price: 0 },
    ]);

    const halfChicken = await upsertMenuItem(client, nCat1, nandos, {
      name: 'Half Chicken',
      description: 'Half flame-grilled PERi-PERi chicken with two sides of your choice.',
      price: 159,
      image: 'https://images.unsplash.com/photo-1598103442097-8b74394b95c5?w=400&q=80',
      display_order: 1,
    });
    await upsertAddonGroup(client, halfChicken, 'PERi-PERi Heat', 1, 1, [
      { name: 'Lemon & Herb', price: 0 },
      { name: 'Mild', price: 0 },
      { name: 'Hot', price: 0 },
      { name: 'Extra Hot', price: 0 },
    ]);

    await upsertMenuItem(client, nCat1, nandos, {
      name: 'Chicken Strips (6)',
      description: 'Six tender chicken strips marinated in PERi-PERi, served with your choice of dip.',
      price: 109,
      image: 'https://images.unsplash.com/photo-1562967914-608f82629710?w=400&q=80',
      display_order: 2,
    });

    await upsertMenuItem(client, nCat2, nandos, {
      name: 'PERi-PERi Chips',
      description: 'Crispy seasoned chips dusted with PERi-PERi spice.',
      price: 45,
      image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80',
      display_order: 0,
    });

    await upsertMenuItem(client, nCat2, nandos, {
      name: 'Coleslaw',
      description: 'Creamy homemade coleslaw, a Nando\'s classic.',
      price: 35,
      image: 'https://images.unsplash.com/photo-1551248429-40975aa4de74?w=400&q=80',
      display_order: 1,
    });

    await upsertMenuItem(client, nCat3, nandos, {
      name: 'Bottomless Soft Drink',
      description: 'Choose from Coke, Sprite, Fanta or Appletiser.',
      price: 38,
      image: 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=400&q=80',
      display_order: 0,
    });

    // ─── Debonairs ────────────────────────────────────────────────────
    const debonairs = await upsertRestaurant(client, {
      name: 'Debonairs Pizza',
      slug: 'debonairs',
      description: "SA's pizza pioneers. Triple-Decker, Dbl Decker & more, fresh out the oven.",
      cover_image: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=800&q=80',
      logo: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=200&q=80',
      category_id: catMap['pizza'],
      rating: 4.2,
      review_count: 987,
      delivery_time_min: 30,
      delivery_time_max: 50,
      delivery_fee: 35,
      min_order: 100,
      is_open: true,
      is_featured: true,
      address: '45 Commissioner Street, Johannesburg CBD',
      latitude: -26.2041,
      longitude: 28.0473,
    });

    const dCat1 = await upsertMenuCategory(client, debonairs, 'Pizzas', 0);
    const dCat2 = await upsertMenuCategory(client, debonairs, 'Sides & Extras', 1);

    const margarita = await upsertMenuItem(client, dCat1, debonairs, {
      name: 'Margherita',
      description: 'Classic tomato base, mozzarella, fresh basil.',
      price: 99,
      image: 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?w=400&q=80',
      display_order: 0,
    });
    await upsertAddonGroup(client, margarita, 'Size', 1, 1, [
      { name: 'Small (23cm)', price: 0 },
      { name: 'Medium (30cm)', price: 30 },
      { name: 'Large (36cm)', price: 60 },
    ]);

    const bbqChicken = await upsertMenuItem(client, dCat1, debonairs, {
      name: 'BBQ Chicken',
      description: 'BBQ base, grilled chicken strips, peppers and caramelised onion.',
      price: 129,
      image: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=400&q=80',
      display_order: 1,
    });
    await upsertAddonGroup(client, bbqChicken, 'Size', 1, 1, [
      { name: 'Small (23cm)', price: 0 },
      { name: 'Medium (30cm)', price: 30 },
      { name: 'Large (36cm)', price: 60 },
    ]);

    const tripleDeckerItem = await upsertMenuItem(client, dCat1, debonairs, {
      name: 'Triple Decker',
      description: "Debonairs' famous three-layer pizza — double the toppings, double the cheese.",
      price: 179,
      image: 'https://images.unsplash.com/photo-1571407970349-bc81e7e96d47?w=400&q=80',
      display_order: 2,
    });
    await upsertAddonGroup(client, tripleDeckerItem, 'Size', 1, 1, [
      { name: 'Medium (30cm)', price: 0 },
      { name: 'Large (36cm)', price: 40 },
    ]);

    await upsertMenuItem(client, dCat2, debonairs, {
      name: 'Garlic Bread',
      description: 'Oven-fresh garlic bread with herb butter.',
      price: 39,
      image: 'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=400&q=80',
      display_order: 0,
    });

    await upsertMenuItem(client, dCat2, debonairs, {
      name: 'Loaded Potato Wedges',
      description: 'Thick-cut potato wedges with sour cream and sweet chilli.',
      price: 55,
      image: 'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=400&q=80',
      display_order: 1,
    });

    // ─── Kauai ────────────────────────────────────────────────────────
    const kauai = await upsertRestaurant(client, {
      name: 'Kauai',
      slug: 'kauai',
      description: 'Fresh, wholesome food made with love. Wraps, smoothies, salads & more.',
      cover_image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=800&q=80',
      logo: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=200&q=80',
      category_id: catMap['healthy'],
      rating: 4.6,
      review_count: 743,
      delivery_time_min: 20,
      delivery_time_max: 35,
      delivery_fee: 35,
      min_order: 70,
      is_open: true,
      is_featured: false,
      address: 'Shop 12, Rosebank Mall, Johannesburg',
      latitude: -26.1461,
      longitude: 28.0436,
    });

    const kCat1 = await upsertMenuCategory(client, kauai, 'Wraps & Rolls', 0);
    const kCat2 = await upsertMenuCategory(client, kauai, 'Smoothies & Juices', 1);

    await upsertMenuItem(client, kCat1, kauai, {
      name: 'Chicken Avocado Wrap',
      description: 'Grilled chicken, avo, mixed greens, tomato and honey mustard in a whole-wheat wrap.',
      price: 89,
      image: 'https://images.unsplash.com/photo-1626700051175-6818013e1d4f?w=400&q=80',
      display_order: 0,
    });

    await upsertMenuItem(client, kCat1, kauai, {
      name: 'Vegan Rainbow Bowl',
      description: 'Quinoa, roasted veggies, chickpeas, tahini dressing.',
      price: 99,
      image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=400&q=80',
      display_order: 1,
    });

    await upsertMenuItem(client, kCat1, kauai, {
      name: 'Tuna & Avo Wholewheat Roll',
      description: 'Tuna mayo, sliced avo, cucumber and rocket in a freshly baked roll.',
      price: 79,
      image: 'https://images.unsplash.com/photo-1553909489-cd47e0907980?w=400&q=80',
      display_order: 2,
    });

    const smoothie = await upsertMenuItem(client, kCat2, kauai, {
      name: 'Protein Shake',
      description: 'Vanilla or chocolate protein shake blended with banana and oat milk.',
      price: 65,
      image: 'https://images.unsplash.com/photo-1553530666-ba11a7da3888?w=400&q=80',
      display_order: 0,
    });
    await upsertAddonGroup(client, smoothie, 'Flavour', 1, 1, [
      { name: 'Vanilla', price: 0 },
      { name: 'Chocolate', price: 0 },
      { name: 'Strawberry', price: 0 },
    ]);

    await upsertMenuItem(client, kCat2, kauai, {
      name: 'Green Detox Juice',
      description: 'Spinach, cucumber, green apple, ginger and lemon.',
      price: 55,
      image: 'https://images.unsplash.com/photo-1615485290382-441e4d049cb5?w=400&q=80',
      display_order: 1,
    });

    // ─── Ocean Basket ─────────────────────────────────────────────────
    const oceanBasket = await upsertRestaurant(client, {
      name: 'Ocean Basket',
      slug: 'ocean-basket',
      description: 'Fresh seafood, Mediterranean style. Prawns, calamari, fish and more.',
      cover_image: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800&q=80',
      logo: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=200&q=80',
      category_id: catMap['seafood'],
      rating: 4.4,
      review_count: 612,
      delivery_time_min: 35,
      delivery_time_max: 55,
      delivery_fee: 45,
      min_order: 120,
      is_open: true,
      is_featured: true,
      address: '203 Oxford Road, Illovo, Johannesburg',
      latitude: -26.1309,
      longitude: 28.0478,
    });

    const oCat1 = await upsertMenuCategory(client, oceanBasket, 'Mains', 0);
    const oCat2 = await upsertMenuCategory(client, oceanBasket, 'Starters', 1);

    await upsertMenuItem(client, oCat1, oceanBasket, {
      name: 'Calamari (300g)',
      description: 'Tender calamari tubes lightly crumbed and fried, served with tartare sauce.',
      price: 139,
      image: 'https://images.unsplash.com/photo-1609501676725-7186f017a4b7?w=400&q=80',
      display_order: 0,
    });

    const prawns = await upsertMenuItem(client, oCat1, oceanBasket, {
      name: 'Mozambican Prawns (500g)',
      description: 'Shell-on prawns in a rich, buttery Mozambican sauce with peri-peri.',
      price: 219,
      image: 'https://images.unsplash.com/photo-1565680018434-b513d5e5fd47?w=400&q=80',
      display_order: 1,
    });
    await upsertAddonGroup(client, prawns, 'Sauce', 1, 1, [
      { name: 'Mozambican', price: 0 },
      { name: 'Garlic Butter', price: 0 },
      { name: 'Lemon Butter', price: 0 },
    ]);

    await upsertMenuItem(client, oCat1, oceanBasket, {
      name: 'Linefish of the Day',
      description: 'Fresh catch, your choice of grilled or fried, served with chips and salad.',
      price: 169,
      image: 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=400&q=80',
      display_order: 2,
    });

    await upsertMenuItem(client, oCat2, oceanBasket, {
      name: 'Calamari Heads',
      description: 'Crispy fried calamari heads — a classic starter.',
      price: 79,
      image: 'https://images.unsplash.com/photo-1609501676725-7186f017a4b7?w=400&q=80',
      display_order: 0,
    });

    await upsertMenuItem(client, oCat2, oceanBasket, {
      name: 'Garlic Bread with Cheese',
      description: 'Toasted garlic bread topped with melted mozzarella.',
      price: 49,
      image: 'https://images.unsplash.com/photo-1573140247632-f8fd74997d5c?w=400&q=80',
      display_order: 1,
    });

    console.log('Seed complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function upsertRestaurant(client: import('pg').PoolClient, r: {
  name: string; slug: string; description: string; cover_image: string; logo: string;
  category_id: string; rating: number; review_count: number; delivery_time_min: number;
  delivery_time_max: number; delivery_fee: number; min_order: number; is_open: boolean;
  is_featured: boolean; address: string; latitude: number; longitude: number;
}) {
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

async function upsertMenuCategory(client: import('pg').PoolClient, restaurantId: string, name: string, order: number) {
  const res = await client.query(`
    INSERT INTO menu_categories (restaurant_id, name, display_order)
    VALUES ($1, $2, $3)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [restaurantId, name, order]);
  if (res.rows.length) return res.rows[0].id as string;
  const existing = await client.query(
    'SELECT id FROM menu_categories WHERE restaurant_id=$1 AND name=$2', [restaurantId, name]
  );
  return existing.rows[0].id as string;
}

async function upsertMenuItem(client: import('pg').PoolClient, menuCategoryId: string, restaurantId: string, item: {
  name: string; description: string; price: number; image: string; display_order: number;
}) {
  const res = await client.query(`
    INSERT INTO menu_items (menu_category_id, restaurant_id, name, description, price, image, display_order)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [menuCategoryId, restaurantId, item.name, item.description, item.price, item.image, item.display_order]);
  if (res.rows.length) return res.rows[0].id as string;
  const existing = await client.query(
    'SELECT id FROM menu_items WHERE menu_category_id=$1 AND name=$2', [menuCategoryId, item.name]
  );
  return existing.rows[0].id as string;
}

async function upsertAddonGroup(
  client: import('pg').PoolClient,
  menuItemId: string,
  name: string,
  minSelections: number,
  maxSelections: number,
  addons: { name: string; price: number }[]
) {
  let groupId: string;
  const existing = await client.query(
    'SELECT id FROM addon_groups WHERE menu_item_id=$1 AND name=$2', [menuItemId, name]
  );
  if (existing.rows.length) {
    groupId = existing.rows[0].id as string;
  } else {
    const res = await client.query(`
      INSERT INTO addon_groups (menu_item_id, name, min_selections, max_selections)
      VALUES ($1,$2,$3,$4) RETURNING id
    `, [menuItemId, name, minSelections, maxSelections]);
    groupId = res.rows[0].id as string;
  }
  for (const addon of addons) {
    await client.query(`
      INSERT INTO addons (addon_group_id, name, price)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
    `, [groupId, addon.name, addon.price]);
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
