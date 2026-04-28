const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ───
const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://gyjjjigkpsqmtevfytgm.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY;
const SYNC_SECRET   = process.env.SYNC_SECRET || 'mikroutz-sync-2025';
const PUBLISHER_ID  = 'CD28202';
const LINKWISE_BASE = 'https://affiliate.linkwi.se/feeds/1.2';
const COLUMNS       = 'product_name,category,brand_name,tracking_url,image_url,in_stock,on_sale,price,discount,size';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── STORE MAPPING ───
const STORE_MAP = {
  'go':          'Μουστάκας',
  'moustakas':   'Μουστάκας',
  'lighthouse':  'Lighthouse',
  'mothercare':  'Mothercare',
  'public':      'Public',
  'jumbo':       'Jumbo',
  'babymarkt':   'BabyMarkt',
  'plaisio':     'Plaisio',
  'kotsovolos':  'Kotsovolos',
};

function mapStore(rawStore) {
  if (!rawStore) return rawStore;
  const key = rawStore.toLowerCase().trim();
  return STORE_MAP[key] || rawStore;
}

// ─── FEEDS ───
const FEEDS = [
  {
    id: 'main',
    name: 'Παιδικά Προϊόντα',
    url: `${LINKWISE_BASE}/${PUBLISHER_ID}/programs-joined/columns-${COLUMNS}/catinc-0/catex-0/proginc-10784-281,11307-622/progex-0/feed.json`,
  },
];

// ─── HELPERS ───
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const chunks = [];
    const req = lib.get(url, {
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mikroutz/1.0)' },
    }, res => {
      console.log(`[fetch] HTTP ${res.statusCode} <- ${url.slice(0, 100)}`);
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout after 120s')); });
  });
}

function parsePrice(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[^\d.,]/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseFeedItems(rawText, feedId, feedName) {
  console.log(`[parse] ${feedName} - Length: ${rawText.length}, Preview: ${rawText.slice(0, 150)}`);

  let data;
  try { data = JSON.parse(rawText); }
  catch (e) { console.error('[parse] JSON error:', e.message); return []; }

  let items = Array.isArray(data) ? data
    : (data.products || data.items || data.data || data.feed || []);
  if (!Array.isArray(items)) items = [];

  console.log(`[parse] ${feedName}: ${items.length} raw items`);

  return items.map((item, idx) => {
    const title    = item.product_name || item.name || item.title || '';
    const link     = item.tracking_url || item.url || item.link || '';
    const image    = item.image_url || item.image || '';
    const price    = parsePrice(item.price);
    const discount = parsePrice(item.discount);
    const oldPrice = (discount && price && discount > 0)
      ? Math.round((price / (1 - discount / 100)) * 100) / 100
      : null;
    const category = item.category
      ? String(item.category).replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
      : feedName;
    const brand    = item.brand_name || item.brand || '';
    // in_stock: default true αν δεν υπάρχει τιμή
    const inStock  = item.in_stock === false || item.in_stock === 0
                  || item.in_stock === '0' || item.in_stock === 'false'
                  || item.in_stock === 'no' ? false : true;
    const desc     = item.description || '';

    let store = item.store_name || item.merchant_name || '';
    if (!store && link) {
      try {
        const domain = new URL(link).hostname.replace('www.', '');
        store = domain.split('.')[0];
        store = store.charAt(0).toUpperCase() + store.slice(1);
      } catch {}
    }
    store = mapStore(store || feedName);

    return {
      feed_id:     `${feedId}_${idx}_${title.slice(0,15).replace(/\W/g,'')}`.slice(0, 200),
      title:       String(title).trim().slice(0, 500),
      description: String(desc).replace(/<[^>]*>/g, '').trim().slice(0, 1000),
      price,
      old_price:   oldPrice,
      image_url:   String(image).trim().slice(0, 1000),
      product_url: String(link).trim().slice(0, 1000),
      store:       String(store).trim().slice(0, 200),
      category:    category.slice(0, 200),
      brand:       String(brand).trim().slice(0, 200),
      ean:         '',
      in_stock:    inStock,
      synced_at:   new Date().toISOString(),
    };
  }).filter(p => p.title && p.product_url);
}

// ─── SYNC (background) ───
app.post('/api/sync', async (req, res) => {
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ ok: true, message: 'Sync started in background. Check /api/status for progress.' });

  (async () => {
    for (const feed of FEEDS) {
      try {
        console.log(`[sync] Fetching: ${feed.url}`);
        const raw = await fetchUrl(feed.url);
        if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) {
          console.error(`[sync] Bad response:`, raw.slice(0, 200));
          continue;
        }
        const items = parseFeedItems(raw, feed.id, feed.name);
        if (!items.length) { console.log(`[sync] ${feed.name}: no items`); continue; }

        let inserted = 0;
        for (let i = 0; i < items.length; i += 200) {
          const { error } = await supabase
            .from('products')
            .upsert(items.slice(i, i + 200), { onConflict: 'feed_id' });
          if (error) { console.error('[sync] upsert error:', error.message); break; }
          inserted += Math.min(200, items.length - i);
        }
        console.log(`[sync] ${feed.name}: ${inserted} upserted`);
      } catch (err) {
        console.error(`[sync] ${feed.name}:`, err.message);
      }
    }
    console.log('[sync] All feeds done.');
  })();
});

// ─── SEARCH ───
app.get('/api/search', async (req, res) => {
  const { q = '', cat = '', min, max, sort = 'relevance', page = 1 } = req.query;
  const limit = 40;
  const offset = (parseInt(page) - 1) * limit;

  try {
    let query = supabase
      .from('products')
      .select('id,title,price,old_price,image_url,product_url,store,category,brand,in_stock', { count: 'exact' })
      .not('price', 'is', null)
      .range(offset, offset + limit - 1);

    // Φιλτράρισμα in_stock — δείχνουμε και null (θεωρούνται διαθέσιμα)
    query = query.or('in_stock.is.null,in_stock.eq.true');

    if (q.trim()) {
      query = query.textSearch('search_vector', q.trim(), { type: 'plain', config: 'simple' });
    }
    if (cat) query = query.ilike('category', `%${cat}%`);
    if (min) query = query.gte('price', parseFloat(min));
    if (max) query = query.lte('price', parseFloat(max));

    if (sort === 'price_asc')       query = query.order('price', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price', { ascending: false });
    else                            query = query.order('synced_at', { ascending: false });

    const { data, error, count } = await query;
    if (error) throw error;

    // Apply store mapping στα αποτελέσματα
    const results = (data || []).map(p => ({
      ...p,
      store: mapStore(p.store),
    }));

    res.json({ ok: true, total: count, page: parseInt(page), results });
  } catch (err) {
    console.error('[search] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CATEGORIES ───
app.get('/api/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('category')
      .limit(5000);
    if (error) throw error;
    const counts = {};
    (data || []).forEach(r => {
      const c = (r.category || 'Άλλα').split('>')[0].trim(); // πρώτο επίπεδο κατηγορίας
      counts[c] = (counts[c] || 0) + 1;
    });
    const cats = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,20).map(([name,count]) => ({name,count}));
    res.json({ ok: true, categories: cats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CHAT ───
app.post('/api/chat', async (req, res) => {
  const { messages = [], profileContext = '' } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No Anthropic key' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 400,
        system: `Βοηθός Γονέα του μικρoutz, παιδικά προϊόντα 0-13 ετών. ${profileContext} Απάντα ελληνικά, 2-4 προτάσεις, λίγα emoji.`,
        messages: messages.slice(-10),
      }),
    });
    const d = await r.json();
    res.json({ ok: true, reply: d.content?.[0]?.text || 'Δοκίμασε ξανά!' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── STATUS ───
app.get('/api/status', async (req, res) => {
  const { count } = await supabase.from('products').select('*', { count: 'exact', head: true });
  res.json({ ok: true, total_products: count, timestamp: new Date().toISOString() });
});

// ─── CRON 24h ───
setInterval(async () => {
  console.log('[cron] Auto-sync starting...');
  for (const feed of FEEDS) {
    try {
      const raw = await fetchUrl(feed.url);
      if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) continue;
      const items = parseFeedItems(raw, feed.id, feed.name);
      for (let i = 0; i < items.length; i += 200) {
        await supabase.from('products').upsert(items.slice(i, i + 200), { onConflict: 'feed_id' });
      }
      console.log(`[cron] ${feed.name}: ${items.length} synced`);
    } catch (e) { console.error(`[cron] ${feed.name}:`, e.message); }
  }
}, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`mikroutz backend on port ${PORT}`));
