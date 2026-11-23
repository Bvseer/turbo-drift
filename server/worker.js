// Turbo Drift — the bot's replies and the world records.
// Cloudflare Worker. Needs: a D1 database bound as DB, secrets BOT_TOKEN and HOOK_SECRET.
// Optional plain variables: GAME_URL (where the game is hosted), BOT_NAME, APP_NAME.

const TRACKS = 32;                                   // Кольцо, Змейка, Шпильки, Токио, Осака, Ташкент, Париж, Мадрид, Лондон, Лос-Анджелес, Сан-Франциско, Майами, Дубай, Монако, Чикаго; room is left for more (32 in all), so that a new track needs no new server
const MIN_MS = [69000, 57000, 87000, 74000, 70000, 70000, 66000, 83000, 70000, 64000, 73000, 69000, 82000, 65000, 78000, 83000], MIN_DEF = 45000;      // lowered twice with the cars: the higher top speed of version 86, the much faster dear cars of version 87      // the last one is Tashkent after its lap was redrawn (the game sends it as track 15)   // nobody drives a clean race faster than this: such a time is not taken (MIN_DEF for a track not listed yet)
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
  let cmds = null; try { for (const scope of [{ type: 'default' }, { type: 'all_group_chats' }]) cmds = await (await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/setMyCommands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commands: BOT_COMMANDS, scope: scope }) })).json(); } catch (e) {}
  return { tables: 'ok', webhook: hook, commands: cmds };
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

// The player's own things, kept by his Telegram id: coins, the cars he has bought, his best times. The game sends what changed on the device since
// the last answer (coins earned or spent, cars bought) and gets the whole state back, so two devices never overwrite each other.
// A device that comes here for the first time sends everything it holds (`first`); that is joined to what is already kept: every car of both, the larger purse.
const COINS_MAX = 10000000;
async function withSave(env, work) {          // the table is made the first time it is needed: no new setup step
  try { return await work(); } catch (e) { const m = String(e && e.message || e);
    if (/no such table/i.test(m)) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS save (uid INTEGER PRIMARY KEY, coins INTEGER NOT NULL, owned TEXT NOT NULL, best TEXT NOT NULL, at INTEGER NOT NULL, prog TEXT, look TEXT)').run(); return await work(); }
    if (/no such column|no column named|has no column/i.test(m)) { for (const c of ['prog', 'look']) { try { await env.DB.prepare('ALTER TABLE save ADD COLUMN ' + c + ' TEXT').run(); } catch (e2) {} } return await work(); }       // a table made before stages and the career existed
    throw e; }
}
// Progress that only grows (stages of the cars, parts bought, career stars): a flat map of small integers. The larger number wins;
// for the keys that begin with 'o', which are sets of bought things, the bits are joined.
function progJoin(into, from) { if (!from || typeof from !== 'object') return into; let n = 0;
  for (const k in from) { if (++n > 300) break; const v = Math.round(+from[k]); if (!/^[a-z0-9]{1,8}$/.test(k) || !(v >= 0 && v <= 1048575)) continue; const was = into[k] | 0; into[k] = k[0] === 'o' ? (was | v) : Math.max(was, v); }
  const keys = Object.keys(into); if (keys.length > 300) for (const k of keys.slice(300)) delete into[k]; return into; }
// What the player has picked to drive: the car, its paint, the parts fitted to each car. Unlike the progress above this can go back as well as
// forward, so the newest choice wins: every device stamps its choice with the time it was made.
function lookClean(v, now) { if (!v || typeof v !== 'object') return null; const t = Math.min(now, Math.round(+v.t) || 0); if (!(t > 0)) return null;
  const int = (x, hi) => { const n = Math.round(+x); return n >= 0 && n <= hi ? n : 0; }, out = { t: t, car: int(v.car, CARS - 1), home: int(v.home, 63), tune: {} }; let n = 0;
  if (v.tune && typeof v.tune === 'object') for (const k in v.tune) { if (++n > 40) break; const a = v.tune[k]; if (!/^\d{1,2}$/.test(k) || +k >= CARS || !Array.isArray(a)) continue; out.tune[+k] = a.slice(0, 8).map((x) => int(x, 63)); }
  return out; }
async function save(env, q) {
  const me = await whoIs(q.init, env); if (!me) return json({ ok: false, err: 'auth' }, 401);
  const cars = (a) => { const r = []; if (Array.isArray(a)) for (const t of a.slice(0, 64)) if (Number.isInteger(t) && t >= 0 && t < CARS && r.indexOf(t) < 0) r.push(t); return r; };
  const num = (v) => Math.max(-COINS_MAX, Math.min(COINS_MAX, Math.round(+v) || 0)), clamp = (v) => Math.max(0, Math.min(COINS_MAX, v));
  const row = await withSave(env, () => env.DB.prepare('SELECT coins, owned, best, prog, look FROM save WHERE uid = ?').bind(me.id).first());
  let coins = 0, owned = [0, 3], best = {}, prog = {}, look = null, fresh = !row;
  if (row) { coins = row.coins | 0; try { owned = cars(JSON.parse(row.owned)); } catch (e) {} try { best = JSON.parse(row.best) || {}; } catch (e) { best = {}; } try { prog = progJoin({}, JSON.parse(row.prog || '{}')); } catch (e) { prog = {}; } }
  progJoin(prog, q.prog);
  { const now = Date.now(); if (row && row.look) { try { look = lookClean(JSON.parse(row.look), now); } catch (e) { look = null; } } const mine = lookClean(q.look, now); if (mine && (!look || mine.t > look.t)) look = mine; }
  if (q.first && typeof q.first === 'object') { const fc = clamp(num(q.first.coins)); coins = fresh ? fc : Math.max(coins, fc); for (const t of cars(q.first.owned)) if (owned.indexOf(t) < 0) owned.push(t); }
  else { coins = clamp(coins + num(q.d)); for (const t of cars(q.buy)) if (owned.indexOf(t) < 0) owned.push(t); }
  for (const t of [0, 3]) if (owned.indexOf(t) < 0) owned.push(t);
  if (q.best && typeof q.best === 'object') { let n = 0; for (const k in q.best) { if (++n > 300) break; const ms = Math.round(+q.best[k]); if (!/^[a-z0-9]{1,8}$/.test(k) || !(ms >= 20000 && ms <= MAX_MS)) continue; if (!best[k] || ms < best[k]) best[k] = ms; } }
  const keys = Object.keys(best); if (keys.length > 400) best = Object.fromEntries(keys.slice(0, 400).map((k) => [k, best[k]]));
  await env.DB.prepare('INSERT INTO save (uid, coins, owned, best, at, prog, look) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (uid) DO UPDATE SET coins = excluded.coins, owned = excluded.owned, best = excluded.best, at = excluded.at, prog = excluded.prog, look = excluded.look')
    .bind(me.id, coins, JSON.stringify(owned), JSON.stringify(best), Math.floor(Date.now()/1000), JSON.stringify(prog), look ? JSON.stringify(look) : null).run();
  return json({ ok: true, coins: coins, owned: owned, best: best, prog: prog, look: look });
}

// The tournament of the week: one track, Monday to Sunday (UTC), everybody's best time on it in the usual conditions. When the week is over,
// each player who took part is paid by his place the next time he looks at the table: the coins go straight into what the server keeps for him.
const WEEK_S = 7*86400, WEEK_IDS = [0, 1, 2, 3, 4, 15, 6, 7, 8, 9, 10, 11, 12, 13, 14];          // the game's track list in the numbers the records go by
const weekNow = () => Math.floor((Date.now()/1000 + 3*86400)/WEEK_S);                              // 1 January 1970 was a Thursday: three days on, and the weeks turn on Mondays
const weekTrack = (wk) => (wk*7 + 3) % 15;
const weekPrize = (rank) => rank === 1 ? 3000 : rank === 2 ? 2000 : rank === 3 ? 1500 : rank <= 10 ? 700 : rank <= 50 ? 300 : 100;
async function withWeek(env, work) {
  try { return await work(); } catch (e) { if (!/no such table/i.test(String(e && e.message || e))) throw e;
    await env.DB.batch([env.DB.prepare('CREATE TABLE IF NOT EXISTS week (wk INTEGER NOT NULL, uid INTEGER NOT NULL, name TEXT NOT NULL, ms INTEGER NOT NULL, car INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (wk, uid))'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS week_ms ON week (wk, ms)'), env.DB.prepare('CREATE TABLE IF NOT EXISTS wpaid (uid INTEGER NOT NULL, wk INTEGER NOT NULL, PRIMARY KEY (uid, wk))')]); return await work(); }
}
async function week(env, q) {
  const me = await whoIs(q.init, env), wk = weekNow(), ti = weekTrack(wk), out = { ok: true, wk: wk, track: ti, ends: wk*WEEK_S - 3*86400 + WEEK_S };
  if (me && q.ms !== undefined) { const ms = Math.round(+q.ms), car = q.car | 0;
    if (!(car >= 0 && car < CARS) || !(ms >= (MIN_MS[WEEK_IDS[ti]] || MIN_DEF) && ms <= MAX_MS) || (q.track | 0) !== ti) return json({ ok: false, err: 'range' }, 400);
    await withWeek(env, () => env.DB.prepare('INSERT INTO week (wk, uid, name, ms, car, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (wk, uid) DO UPDATE SET name = excluded.name, car = CASE WHEN excluded.ms < week.ms THEN excluded.car ELSE week.car END, at = CASE WHEN excluded.ms < week.ms THEN excluded.at ELSE week.at END, ms = MIN(week.ms, excluded.ms)')
      .bind(wk, me.id, me.name, ms, car, Math.floor(Date.now()/1000)).run()); }
  const rows = (await withWeek(env, () => env.DB.prepare('SELECT uid, name, ms, car FROM week WHERE wk = ? ORDER BY ms ASC, at ASC LIMIT ?').bind(wk, TOP).all())).results || [];
  out.total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM week WHERE wk = ?').bind(wk).first()).n | 0; out.me = null;
  out.top = rows.map((r) => ({ name: r.name, ms: r.ms, car: r.car, me: !!(me && r.uid === me.id) }));
  if (me) { const b = await env.DB.prepare('SELECT ms, car FROM week WHERE wk = ? AND uid = ?').bind(wk, me.id).first();
    if (b) out.me = { rank: ((await env.DB.prepare('SELECT COUNT(*) AS n FROM week WHERE wk = ? AND ms < ?').bind(wk, b.ms).first()).n | 0) + 1, ms: b.ms, car: b.car };
    // last week's prize, once, and only into a purse the server already keeps (a device that has never sent its purse would overwrite it)
    const last = await env.DB.prepare('SELECT ms FROM week WHERE wk = ? AND uid = ?').bind(wk - 1, me.id).first();
    if (last && !(await env.DB.prepare('SELECT 1 AS x FROM wpaid WHERE uid = ? AND wk = ?').bind(me.id, wk - 1).first())) {
      const has = await withSave(env, () => env.DB.prepare('SELECT coins FROM save WHERE uid = ?').bind(me.id).first());
      if (has) { const rank = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM week WHERE wk = ? AND ms < ?').bind(wk - 1, last.ms).first()).n | 0) + 1, coins = weekPrize(rank);
        const ins = await env.DB.prepare('INSERT OR IGNORE INTO wpaid (uid, wk) VALUES (?, ?)').bind(me.id, wk - 1).run();
        if (ins && ins.meta && ins.meta.changes) { await env.DB.prepare('UPDATE save SET coins = MIN(?, coins + ?) WHERE uid = ?').bind(COINS_MAX, coins, me.id).run(); out.won = { wk: wk - 1, rank: rank, coins: coins }; } } } }
  return json(out);
}

// What the bot says. In a private chat it answers anything with the invitation to play. In a group it keeps silent until it is called by a command
// (/play, /race, /top, /help — with or without @name), and its buttons there are plain links: Telegram allows the button that opens a Mini App directly only in private chats.
const TRACK_NAMES = ['Кольцо', 'Змейка', 'Шпильки', 'Токио', 'Осака', 'Ташкент', 'Париж', 'Мадрид', 'Лондон', 'Лос-Анджелес', 'Сан-Франциско', 'Майами', 'Дубай', 'Монако', 'Чикаго'];
const BOT_COMMANDS = [{ command: 'play', description: 'Открыть игру' }, { command: 'race', description: 'Приватная комната: только для этого чата' }, { command: 'online', description: 'Онлайн-гонка со случайными соперниками' }, { command: 'top', description: 'Турнир недели: лучшие времена' }, { command: 'help', description: 'Что умеет бот' }];
const fmtMs = (ms) => { const m = Math.floor(ms/60000), s = Math.floor(ms % 60000/1000), c = Math.floor(ms % 1000/10); return m + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0'); };
async function weekText(env) {
  const wk = weekNow(), ti = weekTrack(wk); let rows = [];
  try { rows = (await withWeek(env, () => env.DB.prepare('SELECT name, ms FROM week WHERE wk = ? ORDER BY ms ASC, at ASC LIMIT 10').bind(wk).all())).results || []; } catch (e) {}
  const left = Math.max(0, wk*WEEK_S - 3*86400 + WEEK_S - Date.now()/1000), d = Math.floor(left/86400), h = Math.floor(left % 86400/3600);
  return '🏆 Турнир недели — трасса «' + TRACK_NAMES[ti] + '»\n' + (rows.length ? rows.map((r, i) => (i + 1) + '. ' + r.name + ' — ' + fmtMs(r.ms)).join('\n') : 'Пока никто не проехал. Будь первым!') + '\n\nДо конца: ' + (d ? d + ' д ' : '') + h + ' ч. Призы: до 3000 монет.';
}
async function telegram(env, request) {
  if (!env.HOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.HOOK_SECRET) return new Response('no', { status: 403 });
  let up = null; try { up = await request.json(); } catch (e) {}
  const m = up && up.message; if (!m || !m.chat) return new Response('ok');
  const priv = m.chat.type === 'private', text = String(m.text || ''), game = env.GAME_URL || 'https://bvseer.github.io/turbo-drift/', bot = env.BOT_NAME || 'TurboDriftBot', app = env.APP_NAME || 'play', link = 'https://t.me/' + bot + '/' + app;
  const send = (body) => fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ chat_id: m.chat.id }, m.message_thread_id ? { message_thread_id: m.message_thread_id } : {}, body)) });
  const cm = /^\/([a-z_]+)(?:@(\w+))?(?:\s|$)/i.exec(text), cmd = cm && (!cm[2] || cm[2].toLowerCase() === bot.toLowerCase()) ? cm[1].toLowerCase() : '';
  const playBtn = priv ? { text: '🏁 Играть', web_app: { url: game } } : { text: '🏁 Играть', url: link }, raceBtn = { text: '🌍 Онлайн-гонка', url: link + '?startapp=online' }, friendsBtn = { text: '👥 Гонка с друзьями', url: link + '?startapp=friends' };          // «friends» opens the game on its room screen: make a room or enter a friend's code
  const intro = '🏁 Turbo Drift — гонки с бонусами прямо в Telegram.\n\nОбгоняй, стреляй ракетами, уходи на турбо. Гоняй с ботами, с друзьями или с игроками со всего мира — и попади в таблицу рекордов.';
  if (!priv && !cmd) return new Response('ok');                       // in a group: only when called
  if (cmd === 'top') { await send({ text: await weekText(env), reply_markup: { inline_keyboard: [[playBtn]] } }); return new Response('ok'); }
  if (cmd === 'race' || cmd === 'room') {          // a room of the caller's own: the link carries a fresh code and who called. The game opens the room when he comes in by it; whoever is early waits for him there
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', rnd = crypto.getRandomValues(new Uint8Array(5)); let code = ''; for (const b of rnd) code += A[b % A.length];
    const anon = !m.from || m.from.is_bot || !!m.sender_chat || !Number.isSafeInteger(m.from.id), who = anon ? '' : String(m.from.first_name || m.from.username || 'Игрок').replace(/[\u0000-\u001f<>]/g, ' ').slice(0, 24);
    const roomBtn = { text: '🚗 В комнату ' + code, url: link + '?startapp=g_' + code + '_' + (anon ? 0 : m.from.id) }, gameBtn = { text: '🏁 Просто играть', url: link };
    await send({ text: anon ? '🔒 Приватная гонка — комната ' + code + '. Попасть в неё можно только по этой кнопке.\n\nЖмите «В комнату». Откроет её тот, кто зайдёт первым, — он и даст старт.'
      : '🔒 ' + who + ' собирает приватную гонку — комната ' + code + '. Попасть в неё можно только по этой кнопке.\n\nЖмите «В комнату». Она откроется, когда ' + who + ' сам зайдёт по этой кнопке: он хозяин и даёт старт. Кто пришёл раньше — подождёт его прямо в игре.', reply_markup: { inline_keyboard: [[roomBtn], [gameBtn]] } }); return new Response('ok'); }
  if (cmd === 'online') { const who = String(m.from && !m.from.is_bot && (m.from.first_name || m.from.username) || '').replace(/[\u0000-\u001f<>]/g, ' ').slice(0, 24);          // the open rooms of the quick match: strangers may be there too
    await send({ text: '🌍 ' + (who ? who + ' зовёт в онлайн-гонку' : 'Онлайн-гонка') + '.\n\nКнопка посадит в открытую комнату с игроками со всего мира — туда попадают и посторонние. Для гонки только своей компанией есть /race.', reply_markup: { inline_keyboard: [[raceBtn], [{ text: '🏁 Просто играть', url: link }]] } }); return new Response('ok'); }
  if (cmd === 'help') { await send({ text: 'Команды:\n/play — открыть игру\n/race — приватная комната: бот даёт ссылку, по ней заходят только свои\n/online — онлайн-гонка в открытой комнате со случайными соперниками\n/top — турнир недели, лучшие времена\n\nВ группе команду надёжнее писать с именем бота: /play@' + bot, reply_markup: { inline_keyboard: [[playBtn]] } }); return new Response('ok'); }
  if (!priv && cmd !== 'play' && cmd !== 'start') return new Response('ok');          // some other bot's command
  if (priv && text.indexOf('/start') === 0) { const k = (text.split(/\s+/)[1] || 'direct').replace(/[^\w-]/g, '').slice(0, 32) || 'direct';      // t.me/<bot>?start=<label>: which advert brought the player
    try { await env.DB.prepare('INSERT INTO src (k, n) VALUES (?, 1) ON CONFLICT (k) DO UPDATE SET n = n + 1').bind(k).run(); } catch (e) {} }
  await send({ text: priv ? intro : intro + '\n\n/race — приватная комната для этого чата\n/online — гонка со случайными соперниками', reply_markup: { inline_keyboard: priv ? [[playBtn], [raceBtn], [friendsBtn]] : [[playBtn]] } });
  return new Response('ok');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (path === '/tg' && request.method === 'POST') return await telegram(env, request);
      if (path === '/top' || path === '/score' || path === '/save' || path === '/week') {
        let q = {}; if (request.method === 'POST') { const t = await request.text(); if (t.length > (path === '/save' ? 20000 : 6000)) return json({ ok: false, err: 'big' }, 413); try { q = JSON.parse(t) || {}; } catch (e) { return json({ ok: false, err: 'json' }, 400); } }
        else q = { track: url.searchParams.get('track') };
        if (path === '/score') return request.method === 'POST' ? await score(env, q, request) : json({ ok: false, err: 'method' }, 405);
        if (path === '/save') return request.method === 'POST' ? await save(env, q) : json({ ok: false, err: 'method' }, 405);
        if (path === '/week') return request.method === 'POST' ? await week(env, q) : json({ ok: false, err: 'method' }, 405);
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
