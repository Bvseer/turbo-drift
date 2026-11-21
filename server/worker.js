// Turbo Drift — the bot's replies and the world records.
// Cloudflare Worker. Needs: a D1 database bound as DB, secrets BOT_TOKEN and HOOK_SECRET.
// Optional plain variables: GAME_URL (where the game is hosted), BOT_NAME, APP_NAME.

const TRACKS = 16;                                   // Кольцо, Змейка, Шпильки, Токио, Осака, Ташкент, Париж, Мадрид, Лондон, Лос-Анджелес, Сан-Франциско, Майами, Дубай, Монако, Чикаго; room is left for more (16 in all), so that a new track needs no new server
const MIN_MS = [90000, 75000, 114000, 97000, 92000, 91000, 86000, 108000, 91000, 84000, 95000, 90000, 107000, 85000, 102000], MIN_DEF = 60000;   // nobody drives a clean race faster than this: such a time is not taken (MIN_DEF for a track not listed yet)
const MAX_MS = 20*60*1000;
const CARS = 32;                                     // car numbers the game may send; the game itself knows their names
const TOP = 15;
const FRESH = 7*24*3600;                             // how old Telegram's signature of a player may be, seconds

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' };
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS) });
const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

// Who is asking: Telegram signs the data it hands to a Mini App with the bot's token, so a name cannot be made up.
async function whoIs(init, env) {
  if (!init || typeof init !== 'string' || init.length > 4096 || !env.BOT_TOKEN) return null;
  const p = new URLSearchParams(init), hash = p.get('hash'); if (!hash) return null;
  const lines = []; for (const [k, v] of p) if (k !== 'hash') lines.push(k + '=' + v); lines.sort();
  const secret = await hmac('WebAppData', env.BOT_TOKEN), sign = hex(await hmac(secret, lines.join('\n')));
  if (!same(sign, hash)) return null;
  const at = parseInt(p.get('auth_date') || '0', 10); if (!(at > 0) || Date.now()/1000 - at > FRESH) return null;
  let u = null; try { u = JSON.parse(p.get('user') || 'null'); } catch (e) {}
  if (!u || !Number.isSafeInteger(u.id)) return null;
  const name = String(u.first_name || u.username || 'Игрок').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Игрок';
  return { id: u.id, name: name };
}

async function setup(env, origin) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS best (track INTEGER NOT NULL, uid INTEGER NOT NULL, name TEXT NOT NULL, ms INTEGER NOT NULL, car INTEGER NOT NULL, at INTEGER NOT NULL, cc TEXT, PRIMARY KEY (track, uid))'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS best_top ON best (track, ms)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS src (k TEXT PRIMARY KEY, n INTEGER NOT NULL)')
  ]);
  const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/setWebhook', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: origin + '/tg', secret_token: env.HOOK_SECRET, allowed_updates: ['message'], drop_pending_updates: true }) });
  let hook = null; try { hook = await r.json(); } catch (e) {}
  return { tables: 'ok', webhook: hook };
}

// The country column came later than the table: a database made before it gets the column the first time it is needed.
async function withCountry(env, work) {
  try { return await work(); } catch (e) { if (!/\bcc\b/.test(String(e && e.message || e))) throw e; try { await env.DB.prepare('ALTER TABLE best ADD COLUMN cc TEXT').run(); } catch (x) {} return await work(); }
}
async function board(env, track, me) {
  const rows = (await withCountry(env, () => env.DB.prepare('SELECT uid, name, ms, car, cc FROM best WHERE track = ? ORDER BY ms ASC, at ASC LIMIT ?').bind(track, TOP).all())).results || [];
  const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM best WHERE track = ?').bind(track).first()).n | 0;
  let mine = null;
  if (me) { const b = await env.DB.prepare('SELECT ms, car FROM best WHERE track = ? AND uid = ?').bind(track, me.id).first();
    if (b) { const r = (await env.DB.prepare('SELECT COUNT(*) AS n FROM best WHERE track = ? AND ms < ?').bind(track, b.ms).first()).n | 0; mine = { rank: r + 1, ms: b.ms, car: b.car }; } }
  return { ok: true, track: track, total: total, me: mine, top: rows.map((r) => ({ name: r.name, ms: r.ms, car: r.car, cc: r.cc || '', me: !!(me && r.uid === me.id) })) };
}

async function score(env, q, request) {
  const me = await whoIs(q.init, env); if (!me) return json({ ok: false, err: 'auth' }, 401);
  const track = q.track | 0, ms = Math.round(+q.ms), car = q.car | 0;
  if (!(track >= 0 && track < TRACKS) || !(car >= 0 && car < CARS) || !(ms >= (MIN_MS[track] || MIN_DEF) && ms <= MAX_MS)) return json({ ok: false, err: 'range' }, 400);
  let cc = String(request && request.cf && request.cf.country || '').toUpperCase(); if (!/^[A-Z]{2}$/.test(cc) || cc === 'XX') cc = '';          // the country the request came from, as Cloudflare sees it
  await withCountry(env, () => env.DB.prepare('INSERT INTO best (track, uid, name, ms, car, at, cc) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (track, uid) DO UPDATE SET name = excluded.name, ' +
    "cc = CASE WHEN excluded.cc != '' THEN excluded.cc ELSE best.cc END, " +
    'car = CASE WHEN excluded.ms < best.ms THEN excluded.car ELSE best.car END, at = CASE WHEN excluded.ms < best.ms THEN excluded.at ELSE best.at END, ms = MIN(best.ms, excluded.ms)')
    .bind(track, me.id, me.name, ms, car, Math.floor(Date.now()/1000), cc).run());
  return json(await board(env, track, me));
}

async function telegram(env, request) {
  if (!env.HOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.HOOK_SECRET) return new Response('no', { status: 403 });
  let up = null; try { up = await request.json(); } catch (e) {}
  const m = up && up.message; if (!m || !m.chat || m.chat.type !== 'private') return new Response('ok');
  const text = String(m.text || ''), game = env.GAME_URL || 'https://bvseer.github.io/turbo-drift/', bot = env.BOT_NAME || 'TurboDriftBot', app = env.APP_NAME || 'play';
  if (text.indexOf('/start') === 0) { const k = (text.split(/\s+/)[1] || 'direct').replace(/[^\w-]/g, '').slice(0, 32) || 'direct';      // t.me/<bot>?start=<label>: which advert brought the player
    try { await env.DB.prepare('INSERT INTO src (k, n) VALUES (?, 1) ON CONFLICT (k) DO UPDATE SET n = n + 1').bind(k).run(); } catch (e) {} }
  const body = { chat_id: m.chat.id, text: '🏁 Turbo Drift — гонки с бонусами прямо в Telegram.\n\nОбгоняй, стреляй ракетами, уходи на турбо. Гоняй с ботами, с друзьями или с игроками со всего мира — и попади в таблицу рекордов.',
    reply_markup: { inline_keyboard: [[{ text: '🏁 Играть', web_app: { url: game } }], [{ text: '🌍 Онлайн-гонка', url: 'https://t.me/' + bot + '/' + app + '?startapp=online' }]] } };
  await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return new Response('ok');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (path === '/tg' && request.method === 'POST') return await telegram(env, request);
      if (path === '/top' || path === '/score') {
        let q = {}; if (request.method === 'POST') { const t = await request.text(); if (t.length > 6000) return json({ ok: false, err: 'big' }, 413); try { q = JSON.parse(t) || {}; } catch (e) { return json({ ok: false, err: 'json' }, 400); } }
        else q = { track: url.searchParams.get('track') };
        if (path === '/score') return request.method === 'POST' ? await score(env, q, request) : json({ ok: false, err: 'method' }, 405);
        const track = q.track | 0; if (!(track >= 0 && track < TRACKS)) return json({ ok: false, err: 'range' }, 400);
        return json(await board(env, track, await whoIs(q.init, env)));
      }
      if (path === '/setup' || path === '/stats') {
        if (!env.HOOK_SECRET || url.searchParams.get('key') !== env.HOOK_SECRET) return json({ ok: false, err: 'key' }, 403);
        if (path === '/setup') return json(Object.assign({ ok: true }, await setup(env, url.origin)));
        const src = (await env.DB.prepare('SELECT k, n FROM src ORDER BY n DESC LIMIT 100').all()).results || [], pl = await env.DB.prepare('SELECT COUNT(DISTINCT uid) AS n FROM best').first();
        return json({ ok: true, starts: src, players_with_records: pl ? pl.n : 0 });
      }
      if (path === '/') return json({ ok: true, name: 'Turbo Drift', db: !!env.DB, token: !!env.BOT_TOKEN, key: !!env.HOOK_SECRET });
      return json({ ok: false, err: 'path' }, 404);
    } catch (e) { return json({ ok: false, err: 'server', msg: String(e && e.message || e).slice(0, 200) }, 500); }
  }
};
