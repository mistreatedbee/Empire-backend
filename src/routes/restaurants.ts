import { Router, Request, Response } from 'express';
import { pool } from '../db';
import { ok, fail } from '../utils/response';

const router = Router();

// GET /restaurants/featured
router.get('/featured', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT r.*, c.name AS category_name, c.slug AS category_slug
      FROM restaurants r
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.is_featured = true
      ORDER BY r.rating DESC
      LIMIT 10
    `);
    ok(res, result.rows.map(mapRestaurant));
  } catch (err) {
    console.error('featured error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /restaurants/popular
router.get('/popular', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT r.*, c.name AS category_name, c.slug AS category_slug
      FROM restaurants r
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.is_open = true
      ORDER BY r.rating DESC, r.review_count DESC
      LIMIT 10
    `);
    ok(res, result.rows.map(mapRestaurant));
  } catch (err) {
    console.error('popular error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /restaurants/search
router.get('/search', async (req: Request, res: Response) => {
  try {
    const q = ((req.query.q as string) ?? '').trim();
    if (!q) {
      ok(res, { restaurants: [], menuItems: [] });
      return;
    }
    const pattern = `%${q}%`;
    const [rRes, mRes] = await Promise.all([
      pool.query(`
        SELECT r.*, c.name AS category_name, c.slug AS category_slug
        FROM restaurants r
        LEFT JOIN categories c ON c.id = r.category_id
        WHERE r.name ILIKE $1 OR r.description ILIKE $1
        LIMIT 10
      `, [pattern]),
      pool.query(`
        SELECT mi.*, r.name AS restaurant_name, r.id AS restaurant_id
        FROM menu_items mi
        JOIN restaurants r ON r.id = mi.restaurant_id
        WHERE mi.name ILIKE $1 OR mi.description ILIKE $1
        AND mi.is_available = true
        LIMIT 10
      `, [pattern]),
    ]);
    ok(res, { restaurants: rRes.rows.map(mapRestaurant), menuItems: mRes.rows });
  } catch (err) {
    console.error('search error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /restaurants
router.get('/', async (req: Request, res: Response) => {
  try {
    const { category, sort } = req.query as Record<string, string>;
    let sql = `
      SELECT r.*, c.name AS category_name, c.slug AS category_slug
      FROM restaurants r
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE 1=1
    `;
    const params: unknown[] = [];
    if (category) {
      params.push(category);
      sql += ` AND c.slug = $${params.length}`;
    }
    if (sort === 'delivery_time') {
      sql += ' ORDER BY r.delivery_time_min ASC';
    } else {
      sql += ' ORDER BY r.rating DESC';
    }
    const result = await pool.query(sql, params);
    ok(res, { data: result.rows.map(mapRestaurant), total: result.rowCount });
  } catch (err) {
    console.error('restaurants list error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /restaurants/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const result = await pool.query(`
      SELECT r.*, c.name AS category_name, c.slug AS category_slug
      FROM restaurants r
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.id = $1
    `, [req.params.id]);
    if (!result.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Restaurant not found.');
      return;
    }
    ok(res, mapRestaurant(result.rows[0]));
  } catch (err) {
    console.error('restaurant detail error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /restaurants/:id/menu
router.get('/:id/menu', async (req: Request, res: Response) => {
  try {
    const restaurantId = req.params.id;
    const [catRows, itemRows, groupRows, addonRows] = await Promise.all([
      pool.query(
        'SELECT * FROM menu_categories WHERE restaurant_id=$1 ORDER BY display_order',
        [restaurantId]
      ),
      pool.query(
        'SELECT * FROM menu_items WHERE restaurant_id=$1 AND is_available=true ORDER BY display_order',
        [restaurantId]
      ),
      pool.query(`
        SELECT ag.* FROM addon_groups ag
        JOIN menu_items mi ON mi.id = ag.menu_item_id
        WHERE mi.restaurant_id = $1
      `, [restaurantId]),
      pool.query(`
        SELECT a.* FROM addons a
        JOIN addon_groups ag ON ag.id = a.addon_group_id
        JOIN menu_items mi ON mi.id = ag.menu_item_id
        WHERE mi.restaurant_id = $1
      `, [restaurantId]),
    ]);

    const addonsByGroup: Record<string, unknown[]> = {};
    for (const a of addonRows.rows) {
      const gid = a.addon_group_id as string;
      if (!addonsByGroup[gid]) addonsByGroup[gid] = [];
      addonsByGroup[gid].push({ id: a.id, name: a.name, price: parseFloat(a.price) });
    }

    const groupsByItem: Record<string, unknown[]> = {};
    for (const g of groupRows.rows) {
      const mid = g.menu_item_id as string;
      if (!groupsByItem[mid]) groupsByItem[mid] = [];
      groupsByItem[mid].push({
        id: g.id,
        name: g.name,
        minSelections: g.min_selections,
        maxSelections: g.max_selections,
        addons: addonsByGroup[g.id as string] ?? [],
      });
    }

    const itemsByCategory: Record<string, unknown[]> = {};
    for (const item of itemRows.rows) {
      const cid = item.menu_category_id as string;
      if (!itemsByCategory[cid]) itemsByCategory[cid] = [];
      itemsByCategory[cid].push(mapMenuItem(item, groupsByItem[item.id as string] ?? []));
    }

    const menu = catRows.rows.map((cat) => ({
      id: cat.id,
      name: cat.name,
      items: itemsByCategory[cat.id as string] ?? [],
    }));

    ok(res, menu);
  } catch (err) {
    console.error('menu error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

// GET /restaurants/:id/menu/:itemId
router.get('/:id/menu/:itemId', async (req: Request, res: Response) => {
  try {
    const itemRow = await pool.query(
      'SELECT * FROM menu_items WHERE id=$1 AND restaurant_id=$2',
      [req.params.itemId, req.params.id]
    );
    if (!itemRow.rows.length) {
      fail(res, 404, 'NOT_FOUND', 'Menu item not found.');
      return;
    }
    const item = itemRow.rows[0];
    const groupRows = await pool.query(
      'SELECT * FROM addon_groups WHERE menu_item_id=$1', [item.id]
    );
    const addonGroups = await Promise.all(groupRows.rows.map(async (g) => {
      const addonRows = await pool.query('SELECT * FROM addons WHERE addon_group_id=$1', [g.id]);
      return {
        id: g.id,
        name: g.name,
        minSelections: g.min_selections,
        maxSelections: g.max_selections,
        addons: addonRows.rows.map((a) => ({ id: a.id, name: a.name, price: parseFloat(a.price) })),
      };
    }));
    ok(res, mapMenuItem(item, addonGroups));
  } catch (err) {
    console.error('menu item error:', err);
    fail(res, 500, 'SERVER_ERROR', 'Something went wrong.');
  }
});

function mapRestaurant(r: Record<string, unknown>) {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    description: r.description,
    coverImage: r.cover_image,
    logo: r.logo,
    category: r.category_name ? { name: r.category_name, slug: r.category_slug } : null,
    rating: parseFloat(r.rating as string),
    reviewCount: r.review_count,
    deliveryTimeMin: r.delivery_time_min,
    deliveryTimeMax: r.delivery_time_max,
    deliveryFee: parseFloat(r.delivery_fee as string),
    minOrder: parseFloat(r.min_order as string),
    isOpen: r.is_open,
    isFeatured: r.is_featured,
    address: r.address,
    latitude: r.latitude ? parseFloat(r.latitude as string) : null,
    longitude: r.longitude ? parseFloat(r.longitude as string) : null,
  };
}

function mapMenuItem(item: Record<string, unknown>, addonGroups: unknown[]) {
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    price: parseFloat(item.price as string),
    image: item.image,
    isAvailable: item.is_available,
    addonGroups,
  };
}

export default router;
