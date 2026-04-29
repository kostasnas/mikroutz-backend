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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── STORE MAPPING — βάσει domain του tracking_url ───
const DOMAIN_TO_STORE = {
  'go.gr':           'Μουστάκας',
  'moustakas':       'Μουστάκας',
  'zackret':         'Zackret',
  'babymarkt':       'BabyMarkt',
  'mothercare':      'Mothercare',
  'public':          'Public',
  'jumbo':           'Jumbo',
  'plaisio':         'Plaisio',
  'kotsovolos':      'Kotsovolos',
  'e-shop':          'e-shop.gr',
  'eshop':           'e-shop.gr',
  'babyhome':        'BabyHome',
  'bebe':            'BebéStores',
  'bebestores':      'BebéStores',
  'funhouse':        'Funhouse',
  'toyland':         'Toyland',
  'kidding':         'Kidding',
  'myminiland':      'MyMiniland',
  'houseofkids':     'House of Kids',
  'mykingdom':       'My Kingdom',
  'babyland':        'Babyland',
  'poulain':         'Poulain',
  'dpam':            'Du Pareil',
  'mayoral':         'Mayoral',
  'energiers':       'Energiers',
  'jakoo':           'Jakoo',
  'babyglory':       'BabyGlory',
  'nuk':             'NUK',
  'chicco':          'Chicco',
  'hauck':           'Hauck',
  'cybex':           'Cybex',
  'joie':            'Joie',
  'inglesina':       'Inglesina',
  'kinderkraft':     'Kinderkraft',
  'graco':           'Graco',
  'peg-perego':      'Peg Perego',
  'fisher-price':    'Fisher-Price',
  'vtech':           'VTech',
  'lego':            'LEGO',
  'playmobil':       'Playmobil',
};

// Program ID → Store name (fallback αν δεν βρεθεί από URL)
const PROGRAM_TO_STORE = {
  '10784': 'Μουστάκας',
  '11307': 'Μουστάκας',
  '13208': 'Zackret',
  '11562': 'BabyMarkt',
  '12814': 'Mothercare',
  '14015': 'Public',
  '11036': 'Jumbo',
  '12761': 'Plaisio',
  '13506': 'BebéStores',
  '10579': 'e-shop.gr',
  '10632': 'Kotsovolos',
  '14114': 'BabyHome',
  '138':   'Funhouse',
  '12174': 'Toyland',
  '14123': 'House of Kids',
  '12345': 'MyMiniland',
  '385':   'Kidding',
  '469':   'Ekos',
  '13255': 'Toysrus',
  '13884': 'Myminiland',
  '399':   'e-shop.gr',
  '11754': 'BebéStores',
  '13604': 'Funhouse',
};

function resolveStore(url, fallback) {
  if (url) {
    try {
      const hostname = new URL(url).hostname.toLowerCase().replace('www.', '');
      for (const [key, name] of Object.entries(DOMAIN_TO_STORE)) {
        if (hostname.includes(key)) return name;
      }
      // Fallback: capitalize domain
      const domain = hostname.split('.')[0];
      if (domain && domain !== 'affiliate' && domain !== 'linkwi') {
        return domain.charAt(0).toUpperCase() + domain.slice(1);
      }
    } catch {}
  }
  return fallback || 'Κατάστημα';
}

// ─── CATEGORY MAPPING ───
// Linkwise catinc IDs → ελληνικά ονόματα
const CATEGORY_MAP = {
  '5':   'Παιχνίδια',
  '27':  'Βρεφικά',
  '45':  'Ρούχα',
  '47':  'Παπούτσια',
  '53':  'Σχολικά',
  '59':  'Αθλητικά',
  '65':  'Βιβλία',
  '75':  'Ηλεκτρονικά',
  '81':  'Τεχνολογία',
  '103': 'Καλοκαιρινά',
  '105': 'Καροτσάκια',
  '107': 'Κρεβάτια & Έπιπλα',
  '111': 'Τρόφιμα & Φαρμακείο',
  '113': 'Ασφάλεια',
  '115': 'Δώρα',
  '117': 'Διάφορα',
};

// ─── FULL FEED URL ───
const FULL_FEED_URL = `${LINKWISE_BASE}/${PUBLISHER_ID}/programs-joined/columns-product_name,category,brand_name,tracking_url,thumb_url,in_stock,on_sale,price,discount,size/catinc-5,27,45,47,53,59,81,65,75,103,105,107,111,113,115,117/catex-0/proginc-13208-2081,11562-711,12814-2701,14015-2746,11036-369,12761-1652,13506-2267,10579-257,10632-237,14114-2761,138-2273,12174-1176,14123-2770,10784-281,12345-1289,385-251,469-2136,13255-2053,13884-2555,399-226,399-292,11307-622,11754-880,13604-2421/progex-0/feed.json`;

const FEEDS = [
  { id: 'main', name: 'Παιδικά Προϊόντα', url: FULL_FEED_URL },
];

// ─── HELPERS ───
const MAX_FEED_BYTES = 8 * 1024 * 1024; // 8MB limit — προστατεύει από OOM

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const chunks = [];
    let totalBytes = 0;
    const req = lib.get(url, {
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; mikroutz/1.0)' },
    }, res => {
      console.log(`[fetch] HTTP ${res.statusCode}`);
      res.on('data', chunk => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_FEED_BYTES) {
          console.log(`[fetch] Byte limit reached (${(totalBytes/1024/1024).toFixed(1)}MB), stopping`);
          req.destroy();
          // Επιστρέφουμε ό,τι έχουμε μέχρι τώρα — κόβουμε στο τελευταίο }
          const partial = Buffer.concat(chunks).toString('utf8');
          const lastBracket = partial.lastIndexOf('},');
          const fixed = lastBracket > 0 ? partial.slice(0, lastBracket) + '}]' : '[]';
          resolve(fixed);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', (e) => { if (!e.message.includes('socket hang')) reject(e); });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout after 120s')); });
  });
}

function parsePrice(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = parseFloat(String(val).replace(/[^\d.,]/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

function cleanCategory(raw) {
  if (!raw) return 'Άλλα';
  return String(raw)
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .trim();
}

function parseFeedItems(rawText, feedId, feedName) {
  console.log(`[parse] Length: ${rawText.length}, Preview: ${rawText.slice(0, 150)}`);
  let data;
  try { data = JSON.parse(rawText); }
  catch (e) { console.error('[parse] JSON error:', e.message); return []; }

  let items = Array.isArray(data) ? data
    : (data.products || data.items || data.data || data.feed || []);
  if (!Array.isArray(items)) items = [];
  console.log(`[parse] ${items.length} raw items`);

  return items.map((item, idx) => {
    const title    = item.product_name || item.name || item.title || '';
    const link     = item.tracking_url || item.url || item.link || '';
    // thumb_url αντί image_url (νέο column στο feed)
    const image    = item.thumb_url || item.image_url || item.image || '';
    const price    = parsePrice(item.price);
    const discount = parsePrice(item.discount);
    const oldPrice = (discount && price && discount > 0)
      ? Math.round((price / (1 - discount / 100)) * 100) / 100
      : null;
    const category = cleanCategory(item.category);
    const brand    = item.brand_name || item.brand || '';
    const inStock  = !(item.in_stock === false || item.in_stock === 0
                    || item.in_stock === '0' || item.in_stock === 'false'
                    || item.in_stock === 'no');
    const store    = resolveStore(link, item.store_name || item.merchant_name);

    return {
      feed_id:     `${feedId}_${idx}_${title.slice(0,15).replace(/\W/g,'')}`.slice(0, 200),
      title:       String(title).trim().slice(0, 500),
      description: '',
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

// ─── SYNC ───
app.post('/api/sync', async (req, res) => {
  if (req.headers['x-sync-secret'] !== SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ ok: true, message: 'Sync started in background. Check /api/status for progress.' });

  (async () => {
    for (const feed of FEEDS) {
      try {
        console.log(`[sync] Fetching feed...`);
        const raw = await fetchUrl(feed.url);
        if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) {
          console.error(`[sync] Bad response:`, raw.slice(0, 200));
          continue;
        }
        const items = parseFeedItems(raw, feed.id, feed.name);
        if (!items.length) { console.log(`[sync] No items parsed`); continue; }

        let inserted = 0;
        for (let i = 0; i < items.length; i += 200) {
          const { error } = await supabase
            .from('products')
            .upsert(items.slice(i, i + 200), { onConflict: 'feed_id' });
          if (error) { console.error('[sync] upsert error:', error.message); break; }
          inserted += Math.min(200, items.length - i);
        }
        console.log(`[sync] Done: ${inserted} upserted out of ${items.length}`);
      } catch (err) {
        console.error(`[sync] Error:`, err.message);
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
    // Κατηγορίες ενηλίκων που εξαιρούνται
    const ADULT_CATS = ['Γυναίκα', 'Άνδρας', 'Σπίτι', 'Είδη σπιτιού', 'Τσάντες', 'Υφασμάτινα', 'Ένδυση - Αξεσουάρ'];

    let query = supabase
      .from('products')
      .select('id,title,price,old_price,image_url,product_url,store,category,brand,in_stock', { count: 'exact' })
      .not('price', 'is', null)
      .or('in_stock.is.null,in_stock.eq.true')
      .not('category', 'ilike', '%Γυναίκα%')
      .not('category', 'ilike', '%Άνδρας%')
      .not('category', 'ilike', '%Είδη σπιτιού%')
      .not('category', 'ilike', '%Υφασμάτινα%')
      .not('category', 'ilike', '%τακούνι%')
      .not('category', 'ilike', '%πλατφόρμα%')
      .not('category', 'ilike', '%Τσάντες%')
      .range(offset, offset + limit - 1);

    if (q && q.trim()) {
      // Prefix search: κάθε λέξη γίνεται "λέξη:*"
      const words = q.trim().split(/\s+/).filter(Boolean);
      const tsQuery = words.map(w => w.replace(/[^\w\u0370-\u03FF\u1F00-\u1FFF]/g, '') + ':*').join(' & ');
      if (tsQuery.replace(/[: &*]/g,'').length > 0) {
        query = query.textSearch('search_vector', tsQuery, { type: 'raw', config: 'simple' });
      }
    }
    // Category filter — δουλεύει και χωρίς q
    if (cat && cat.trim()) {
      query = query.ilike('category', `%${cat.trim()}%`);
    }
    if (min) query = query.gte('price', parseFloat(min));
    if (max) query = query.lte('price', parseFloat(max));

    if (sort === 'price_asc')       query = query.order('price', { ascending: true });
    else if (sort === 'price_desc') query = query.order('price', { ascending: false });
    else                            query = query.order('synced_at', { ascending: false });

    const { data, error, count } = await query;
    if (error) throw error;

    const results = (data || []).map(p => ({
      ...p,
      store: resolveStore(p.product_url, p.store),
    }));

    res.json({ ok: true, total: count, page: parseInt(page), results });
  } catch (err) {
    console.error('[search] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CATEGORIES endpoint — επιστρέφει τα tabs ───
app.get('/api/categories', async (req, res) => {
  // Επιστρέφει και τα hardcoded tabs βάσει catinc IDs
  const tabs = Object.entries(CATEGORY_MAP).map(([id, name]) => ({ id, name }));

  try {
    const { data, error } = await supabase
      .from('products')
      .select('category')
      .limit(5000);
    if (error) throw error;

    const counts = {};
    (data || []).forEach(r => {
      const c = (r.category || 'Άλλα').split('>')[0].trim();
      counts[c] = (counts[c] || 0) + 1;
    });
    const dbCats = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, count]) => ({ name, count }));

    res.json({ ok: true, tabs, categories: dbCats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── CHAT ───
app.post('/api/chat', async (req, res) => {
  const { messages = [], profileContext = '' } = req.body;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
  if (!ANTHROPIC_KEY) {
    console.error('[chat] No ANTHROPIC_KEY set in environment!');
    return res.status(500).json({ error: 'No Anthropic key configured' });
  }
  try {
    // Φιλτράρουμε μόνο user/assistant roles
    const cleanMessages = (messages || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-10);

    if (!cleanMessages.length || cleanMessages[cleanMessages.length-1].role !== 'user') {
      return res.status(400).json({ error: 'Last message must be from user' });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `Είσαι ο Βοηθός Γονέα του mikroutz.gr, ελληνική πλατφόρμα παιδικών προϊόντων για ηλικίες 0-13 ετών. ${profileContext} Βοηθάς γονείς να βρουν κατάλληλα προϊόντα, δίνεις συμβουλές για μεγέθη ρούχων/παπουτσιών, και προτείνεις δώρα. Απάντα πάντα στα ελληνικά, σε 2-4 προτάσεις, με λίγα σχετικά emoji.`,
        messages: cleanMessages,
      }),
    });
    const d = await r.json();
    console.log('[chat] Anthropic response type:', d.type, 'stop_reason:', d.stop_reason);
    if (d.error) {
      console.error('[chat] Anthropic error:', d.error);
      return res.status(500).json({ ok: false, error: d.error.message });
    }
    const reply = d.content?.[0]?.text || 'Δοκίμασε ξανά!';
    res.json({ ok: true, reply });
  } catch (err) {
    console.error('[chat] Error:', err.message);
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
  console.log('[cron] Auto-sync...');
  try {
    const raw = await fetchUrl(FEEDS[0].url);
    if (!raw.trim().startsWith('[') && !raw.trim().startsWith('{')) return;
    const items = parseFeedItems(raw, 'main', 'Παιδικά Προϊόντα');
    for (let i = 0; i < items.length; i += 200) {
      await supabase.from('products').upsert(items.slice(i, i + 200), { onConflict: 'feed_id' });
    }
    console.log(`[cron] ${items.length} synced`);
  } catch (e) { console.error('[cron] Error:', e.message); }
}, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`mikroutz backend on port ${PORT}`));
