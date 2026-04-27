const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ───
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gyjjjigkpsqmtevfytgm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const LINKWISE_KEY = process.env.LINKWISE_KEY;
const SYNC_SECRET  = process.env.SYNC_SECRET || 'mikroutz-sync-2025';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── LINKWISE FEEDS ───
// Κατηγορίες παιδικών προϊόντων — προσθέτεις/αφαιρείς κατά βούληση
const FEEDS = [
  { id: 'baby',     name: 'Βρεφικά',       url: `https://feeds.linkwise.gr/feed/?key=${LINKWISE_KEY}&cat=baby` },
  { id: 'toys',     name: 'Παιχνίδια',     url: `https://feeds.linkwise.gr/feed/?key=${LINKWISE_KEY}&cat=toys` },
  { id: 'clothes',  name: 'Παιδικά Ρούχα', url: `https://feeds.linkwise.gr/feed/?key=${LINKWISE_KEY}&cat=clothes` },
  { id: 'shoes',    name: 'Παιδικά Παπούτσια', url: `https://feeds.linkwise.gr/feed/?key=${LINKWISE_KEY}&cat=shoes` },
  { id: 'school',   name: 'Σχολικά',       url: `https://feeds.linkwise.gr/feed/?key=${LINKWISE_KEY}&cat=school` },
  { id: 'strollers',name: 'Καροτσάκια',    url: `https://feeds.linkwise.gr/feed/?key=${LINKWISE_KEY}&cat=strollers` },
];

// ─── HELPERS ───
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const chunks = [];
    const req = lib.get(url, { timeout: 30000 }, res => {
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout: ' + url)); });
  });
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^\d.,]/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function parseFeedItems(xml, feedId, feedName) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let parsed;
  try { parsed = parser.parse(xml); } catch (e) { return []; }

  // Linkwise feeds είναι RSS ή custom XML — δοκιμάζουμε και τα δύο
  const channel = parsed?.rss?.channel || parsed?.feed || parsed?.products || {};
  const rawItems = channel.item || channel.entry || channel.product || [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items.slice(0, 500).map(item => {
    // RSS fields
    const title       = item.title || item.name || '';
    const description = item.description || item.summary || item.desc || '';
    const link        = item.link || item.url || item['g:link'] || '';
    const image       = item['g:image_link'] || item.image_link || item.image || item.thumbnail || '';
    const price       = parsePrice(item['g:price'] || item.price || item.Price || '');
    const oldPrice    = parsePrice(item['g:sale_price'] || item.old_price || item.oldprice || '');
    const brand       = item['g:brand'] || item.brand || item.Brand || '';
    const category    = item['g:product_type'] || item.category || item.Category || feedName;
    const ean         = item['g:gtin'] || item.ean || item.EAN || item.barcode || '';
    const inStock     = !String(item['g:availability'] || item.availability || 'in stock')
                          .toLowerCase().includes('out');
    // Store name — από το domain του link
    let store = feedName;
    try {
      const domain = new URL(link).hostname.replace('www.', '');
      store = domain.split('.')[0];
      // Capitalize
      store = store.charAt(0).toUpperCase() + store.slice(1);
    } catch {}

    return {
      feed_id:     feedId + '_' + (item.id || item['g:id'] || Math.random().toString(36).slice(2)),
      title:       String(title).trim().slice(0, 500),
      description: String(description).replace(/<[^>]*>/g, '').trim().slice(0, 1000),
      price,
      old_price:   oldPrice !== price ? oldPrice : null,
      image_url:   String(image).trim().slice(0, 1000),
      product_url: String(link).trim().slice(0, 1000),
      store,
      category:    String(category).trim().slice(0, 200),
      brand:       String(brand).trim().slice(0, 200),
      ean:         String(ean).trim().slice(0, 50),
      in_stock:    inStock,
      synced_at:   new Date().toISOString(),
    };
  }).filter(p => p.title && p.product_url);
}

// ─── SYNC ENDPOINT ───
app.post('/api/sync', async (req, res) => {
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = [];
  for (const feed of FEEDS) {
    try {
      console.log(`[sync] Fetching ${feed.name}...`);
      const xml = await fetchUrl(feed.url);
      const items = parseFeedItems(xml, feed.id, feed.name);
      console.log(`[sync] ${feed.name}: ${items.length} items`);

      if (items.length === 0) {
        results.push({ feed: feed.name, inserted: 0, error: 'No items parsed' });
        continue;
      }

      // Upsert σε batches των 100
      let inserted = 0;
      for (let i = 0; i < items.length; i += 100) {
        const batch = items.slice(i, i + 100);
        const { error } = await supabase
          .from('products')
          .upsert(batch, { onConflict: 'feed_id', ignoreDuplicates: false });
        if (error) { console.error('[sync] upsert error:', error.message); break; }
        inserted += batch.length;
      }
      results.push({ feed: feed.name, inserted });
    } catch (err) {
      console.error(`[sync] Error on ${feed.name}:`, err.message);
      results.push({ feed: feed.name, inserted: 0, error: err.message });
    }
  }

  res.json({ ok: true, synced_at: new Date().toISOString(), results });
});

// ─── SEARCH ENDPOINT ───
// GET /api/search?q=παπούτσια&cat=shoes&min=10&max=50&sort=price_asc&page=1
app.get('/api/search', async (req, res) => {
  const { q = '', cat = '', min, max, sort = 'relevance', page = 1 } = req.query;
  const limit = 40;
  const offset = (parseInt(page) - 1) * limit;

  try {
    let query = supabase
      .from('products')
      .select('id,title,price,old_price,image_url,product_url,store,category,brand,in_stock', { count: 'exact' })
      .eq('in_stock', true)
      .not('price', 'is', null)
      .range(offset, offset + limit - 1);

    // Full-text search
    if (q.trim()) {
      query = query.textSearch('search_vector', q.trim(), { type: 'plain', config: 'simple' });
    }

    // Category filter
    if (cat) {
      query = query.ilike('category', `%${cat}%`);
    }

    // Price range
    if (min) query = query.gte('price', parseFloat(min));
    if (max) query = query.lte('price', parseFloat(max));

    // Sort
    if (sort === 'price_asc')  query = query.order('price', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price', { ascending: false });
    else query = query.order('synced_at', { ascending: false });

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ ok: true, total: count, page: parseInt(page), results: data || [] });
  } catch (err) {
    console.error('[search] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CATEGORIES ENDPOINT ───
app.get('/api/categories', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('category')
      .eq('in_stock', true);
    if (error) throw error;

    const counts = {};
    (data || []).forEach(r => {
      const c = (r.category || 'Άλλα').trim();
      counts[c] = (counts[c] || 0) + 1;
    });

    const cats = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    res.json({ ok: true, categories: cats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CHAT ENDPOINT ───
app.post('/api/chat', async (req, res) => {
  const { messages = [], profileContext = '' } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'No Anthropic key configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `Βοηθός Γονέα του μικρoutz, πλατφόρμα παιδικών προϊόντων 0-13 ετών. ${profileContext} Απάντα στα ελληνικά, 2-4 προτάσεις, με λίγα emoji.`,
        messages: messages.slice(-10), // τελευταία 10 μηνύματα
      }),
    });
    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Δοκίμασε ξανά!';
    res.json({ ok: true, reply });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── STATUS ───
app.get('/api/status', async (req, res) => {
  const { count } = await supabase
    .from('products')
    .select('*', { count: 'exact', head: true });
  res.json({ ok: true, total_products: count, timestamp: new Date().toISOString() });
});

// ─── CRON — auto sync κάθε 24h ───
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
setInterval(async () => {
  console.log('[cron] Starting auto-sync...');
  try {
    const fakeReq = { headers: { 'x-sync-secret': SYNC_SECRET } };
    // Trigger sync internally
    for (const feed of FEEDS) {
      const xml = await fetchUrl(feed.url).catch(e => { console.error(e.message); return ''; });
      if (!xml) continue;
      const items = parseFeedItems(xml, feed.id, feed.name);
      for (let i = 0; i < items.length; i += 100) {
        await supabase.from('products').upsert(items.slice(i, i + 100), { onConflict: 'feed_id' });
      }
      console.log(`[cron] ${feed.name}: ${items.length} items synced`);
    }
  } catch (e) { console.error('[cron] Error:', e.message); }
}, TWENTY_FOUR_HOURS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`mikroutz backend running on port ${PORT}`));
