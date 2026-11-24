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
    if (/no such table/i.test(m)) { await env.DB.prepare('CREATE TABLE IF NOT EXISTS save (uid INTEGER PRIMARY KEY, coins INTEGER NOT NULL, owned TEXT NOT NULL, best TEXT NOT NULL, at INTEGER NOT NULL, prog TEXT, look TEXT, tx TEXT, bud TEXT)').run(); return await work(); }
    if (/no such column|no column named|has no column/i.test(m)) { for (const c of ['prog', 'look', 'tx', 'bud']) { try { await env.DB.prepare('ALTER TABLE save ADD COLUMN ' + c + ' TEXT').run(); } catch (e2) {} } return await work(); }       // a table made before stages and the career existed
    throw e; }
}
// Progress that only grows (stages of the cars, parts bought, career stars): a flat map of small integers. The larger number wins;
// for the keys that begin with 'o', which are sets of bought things, the bits are joined.
function progJoin(into, from) { if (!from || typeof from !== 'object') return into; let n = 0;
  for (const k in from) { if (++n > 300) break; const v = Math.round(+from[k]); if (!/^[a-z0-9]{1,8}$/.test(k) || !(v >= 0 && v <= 1048575)) continue; const was = into[k] | 0; into[k] = k[0] === 'o' ? (was | v) : Math.max(was, v); }
  const keys = Object.keys(into); if (keys.length > 300) for (const k of keys.slice(300)) delete into[k]; return into; }
// The server is the cashier. The game says what the player has earned since last time and what he has bought; the server lets the earnings in only
// as fast as racing can bring them (it cannot see a race, so it counts the time), takes the price of every new thing from its own list, and refuses
// the lot when the purse does not cover it. What the game holds afterwards is what the server answers.
const CAR_PRICE = [1500, 25000, 5000, 0, 3000, 2000, 16000, 8000, 12000], STAGE_BASE = [0, 1500, 4000, 10000], PAINT_PRICE = 1500;
const PART_PRICE = { s: [0, 800, 2500, 1500, 4500, 7000], k: [0, 3000, 1500, 6000, 9000], r: [0, 1000, 1500, 1000, 1000], n: [0, 2000, 2000, 2000, 2500, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000], w: [0, 1500, 2500, 4000, 6000, 8000] };
const stagePrice = (t, n) => STAGE_BASE[n] + Math.round((CAR_PRICE[t] || 0)*0.1/100)*100;
const RATE = 5, BUD_MAX = 6000, BUD_NEW = 2000;          // coins a second that racing can bring at the very most; how much may pile up while the game is not heard from; what a newcomer starts with
function shop(prog, from, owned, buy) {                 // what is new in this save and what it costs
  let cost = 0; const np = {}, nc = [];
  for (const t of buy) if (owned.indexOf(t) < 0 && CAR_PRICE[t] !== undefined) { cost += CAR_PRICE[t]; nc.push(t); }
  if (from && typeof from === 'object') { let n = 0;
    for (const k in from) { if (++n > 300) break; const v = Math.round(+from[k]), was = prog[k] | 0; let m; if (!(v >= 0 && v <= 1048575)) continue;
      if ((m = /^s(\d{1,2})$/.exec(k))) { if (CAR_PRICE[+m[1]] === undefined || v > 3 || v <= was) continue; for (let g = was + 1; g <= v; g++) cost += stagePrice(+m[1], g); np[k] = v; }
      else if ((m = /^o(\d{1,2})([skrnw])$/.exec(k))) { const P = PART_PRICE[m[2]], add = v & ~was; let ok = CAR_PRICE[+m[1]] !== undefined && add > 0, c = 0; for (let i = 1; ok && i < 20; i++) if (add & (1 << i)) { if (P[i] === undefined) ok = false; else c += P[i]; } if (ok) { cost += c; np[k] = was | add; } }
      else if (k === 'oc') { const add = v & ~was & 0xFE; if (!add) continue; for (let i = 1; i < 8; i++) if (add & (1 << i)) cost += PAINT_PRICE; np[k] = was | add; } } }
  return { cost: cost, prog: np, cars: nc };
}
const progFree = (from) => { const o = {}; if (from && typeof from === 'object') for (const k in from) { const v = Math.round(+from[k]); if (/^k\d{1,2}$/.test(k) && v >= 0 && v <= 3) o[k] = v; else if (k === 'op' && v >= 0 && v <= 31) o[k] = v; } return o; };          // what is won, not bought: the stars of the tour and the paints taken from its champions
// What the player has picked to drive: the car, its paint, the parts fitted to each car. Unlike the progress above this can go back as well as
// forward, so the newest choice wins: every device stamps its choice with the time it was made.
function lookClean(v, now) { if (!v || typeof v !== 'object') return null; const t = Math.min(now, Math.round(+v.t) || 0); if (!(t > 0)) return null;
  const int = (x, hi) => { const n = Math.round(+x); return n >= 0 && n <= hi ? n : 0; }, out = { t: t, car: int(v.car, CARS - 1), home: int(v.home, 63), tune: {} }; let n = 0;
  if (v.tune && typeof v.tune === 'object') for (const k in v.tune) { if (++n > 40) break; const a = v.tune[k]; if (!/^\d{1,2}$/.test(k) || +k >= CARS || !Array.isArray(a)) continue; out.tune[+k] = a.slice(0, 8).map((x) => int(x, 63)); }
  return out; }
// Measurements: who came, from where, and who came back. A player gets a row the first time the game saves for him — with the day, the
// label of the link that brought him and, if a friend's link did, the friend. Every day he plays leaves one row more; from the two the
// page /stats works out how many of each day's newcomers were back a day, three days and a week later.
const DAY_S = 86400, dayNow = () => Math.floor((Date.now()/1000 + 5*3600)/DAY_S);          // the days turn at midnight in Tashkent
const FIRST_MAX = 2000;                                                                   // how many coins the server takes on trust from a player it sees for the first time
const JUMP = 2500;                                                                        // a gain in one save that no race, task or prize gives: worth a line in the list
const REF_NEW = 1000, REF_OLD = 1000, REF_MAX = 100;                                      // coins to the newcomer and to the friend whose link he came by; how many newcomers one friend is paid for
const srcClean = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
async function withStat(env, work) {
  try { return await work(); } catch (e) { if (!/no such table/i.test(String(e && e.message || e))) throw e;
    await env.DB.batch([env.DB.prepare('CREATE TABLE IF NOT EXISTS usr (uid INTEGER PRIMARY KEY, d0 INTEGER NOT NULL, src TEXT, ref INTEGER, old INTEGER NOT NULL DEFAULT 0, races INTEGER NOT NULL DEFAULT 0)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS usr_d0 ON usr (d0)'), env.DB.prepare('CREATE INDEX IF NOT EXISTS usr_ref ON usr (ref)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS act (day INTEGER NOT NULL, uid INTEGER NOT NULL, races INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, uid))'), env.DB.prepare('CREATE INDEX IF NOT EXISTS act_uid ON act (uid, day)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS grp (chat INTEGER PRIMARY KEY, title TEXT, at INTEGER NOT NULL, week INTEGER NOT NULL DEFAULT 0)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS jump (id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, at INTEGER NOT NULL, d INTEGER NOT NULL, coins INTEGER NOT NULL, how TEXT)')]); return await work(); }
}
// fresh: the server has never kept anything for this player — he is new. Somebody it already knew when the counting began is marked old and left out of the shares.
async function track(env, uid, fresh, q, name) {
  const day = dayNow(), rc = Math.max(0, Math.min(200, q.rc | 0)), out = { bonus: 0, refs: 0 };
  await withStat(env, async () => {
    if (!(await env.DB.prepare('SELECT d0 FROM usr WHERE uid = ?').bind(uid).first())) { let ref = null; const r = Math.round(+q.ref);
      if (fresh && Number.isSafeInteger(r) && r > 0 && r !== uid && (await env.DB.prepare('SELECT 1 AS x FROM save WHERE uid = ?').bind(r).first())
        && ((await env.DB.prepare('SELECT COUNT(*) AS n FROM usr WHERE ref = ?').bind(r).first()).n | 0) < REF_MAX) ref = r;
      const ins = await env.DB.prepare('INSERT OR IGNORE INTO usr (uid, d0, src, ref, old, races) VALUES (?1, ?2, ?3, ?4, ?5, 0)').bind(uid, day, fresh ? (ref ? 'ref' : (srcClean(q.src) || 'direct')) : 'old', ref, fresh ? 0 : 1).run();
      if (ref && ins && ins.meta && ins.meta.changes) { await env.DB.prepare('UPDATE save SET coins = MIN(?, coins + ?) WHERE uid = ?').bind(COINS_MAX, REF_OLD, ref).run(); out.bonus = REF_NEW; } }
    await env.DB.prepare('INSERT INTO act (day, uid, races) VALUES (?1, ?2, ?3) ON CONFLICT (day, uid) DO UPDATE SET races = races + excluded.races').bind(day, uid, rc).run();
    const put = () => env.DB.prepare('UPDATE usr SET races = races + ?1, name = ?2 WHERE uid = ?3').bind(rc, name || null, uid).run();
    try { await put(); } catch (e) { if (!/name/.test(String(e && e.message || e))) throw e; try { await env.DB.prepare('ALTER TABLE usr ADD COLUMN name TEXT').run(); } catch (x) {} await put(); }          // the name column came a day later than the table
    out.refs = (await env.DB.prepare('SELECT COUNT(*) AS n FROM usr WHERE ref = ?').bind(uid).first()).n | 0; });
  return out;
}
async function stats(env) {
  const day = dayNow(), from = day - 13, all = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results || []), back = (k) => 'EXISTS(SELECT 1 FROM act a WHERE a.uid = u.uid AND a.day = u.d0 + ' + k + ')';
  return await withStat(env, async () => ({ ok: true, day: day,
    total: await env.DB.prepare('SELECT COUNT(*) AS players, COALESCE(SUM(old = 0), 0) AS fresh, COALESCE(SUM(races), 0) AS races FROM usr').first(),
    days: await all('SELECT day, COUNT(*) AS dau, COALESCE(SUM(races), 0) AS races FROM act WHERE day >= ? GROUP BY day ORDER BY day DESC', from),
    cohorts: await all('SELECT u.d0 AS day, COUNT(*) AS n, SUM(' + back(1) + ') AS r1, SUM(' + back(3) + ') AS r3, SUM(' + back(7) + ') AS r7, SUM(EXISTS(SELECT 1 FROM act a WHERE a.uid = u.uid AND a.day > u.d0)) AS ever FROM usr u WHERE u.old = 0 AND u.d0 >= ? GROUP BY u.d0 ORDER BY u.d0 DESC', from),
    sources: await all('SELECT u.src AS src, COUNT(*) AS n, COALESCE(SUM(u.d0 < ?1), 0) AS base, COALESCE(SUM(u.d0 < ?1 AND ' + back(1) + '), 0) AS r1, COALESCE(SUM(u.races), 0) AS races FROM usr u WHERE u.old = 0 GROUP BY u.src ORDER BY n DESC LIMIT 40', day),
    refs: await all('SELECT ref, COUNT(*) AS n FROM usr WHERE ref IS NOT NULL GROUP BY ref ORDER BY n DESC LIMIT 10'),
    groups: ((await env.DB.prepare('SELECT COUNT(*) AS n FROM grp').first()) || {}).n | 0,
    players: await withSave(env, () => all('SELECT s.uid AS uid, s.coins AS coins, s.owned AS owned, s.at AS at, u.name AS name, u.d0 AS d0, u.src AS src, u.races AS races, u.old AS old FROM save s LEFT JOIN usr u ON u.uid = s.uid ORDER BY s.coins DESC LIMIT 200')),
    jumps: await all('SELECT j.uid AS uid, j.at AS at, j.d AS d, j.coins AS coins, j.how AS how, u.name AS name FROM jump j LEFT JOIN usr u ON u.uid = j.uid ORDER BY j.id DESC LIMIT 60') }));
}
// The page of figures: a row of headline numbers, three small charts of the last two weeks (one measure each, on its own scale),
// then the same and the rest as tables. Drawn here as plain HTML and SVG, nothing is loaded from outside.
const CAR_INFO = [['Вектор GT', 1500], ['Аурум V10', 25000], ['Гром 427', 5000], ['Спарк RS', 0], ['Атлас', 3000], ['Зефир', 2000], ['Фантом V12', 16000], ['Ион', 8000], ['Легат V8', 12000]];          // the game's cars by number: name and price
function statsPage(st, starts, recs) {
  const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const date = (d) => { const t = new Date(d*DAY_S*1000); return String(t.getUTCDate()).padStart(2, '0') + '.' + String(t.getUTCMonth() + 1).padStart(2, '0'); };
  const dau = {}, coh = {}; for (const r of st.days) dau[r.day] = r; for (const r of st.cohorts) coh[r.day] = r;
  const days = []; for (let d = st.day - 13; d <= st.day; d++) { const a = dau[d] || {}, c = coh[d] || {}; days.push({ d: d, age: st.day - d, n: c.n | 0, dau: a.dau | 0, races: a.races | 0, r1: c.r1 | 0, r3: c.r3 | 0, r7: c.r7 | 0, ever: c.ever | 0 }); }
  const today = days[13], yest = days[12], sum = (k, minAge) => days.reduce((t, x) => t + (x.age >= minAge ? x[k] : 0), 0), share = (a, b) => b > 0 ? Math.round(a*100/b) : null;
  const d1 = share(sum('r1', 1), sum('n', 1)), d7 = share(sum('r7', 7), sum('n', 7));
  const tile = (label, value, note) => '<div class="tile"><span>' + label + '</span><b>' + esc(value) + '</b><small>' + esc(note || ' ') + '</small></div>';
  // a column chart of one measure: columns no wider than 24, rounded at the top, square on the baseline; the peak and today carry their values
  const chart = (title, key, unit) => { const W = 340, H = 150, L = 30, R = 6, T = 16, B = 22, pw = W - L - R, ph = H - T - B, band = pw/14, bw = Math.min(24, band - 4), top = Math.max(1, ...days.map((x) => x[key]));
    const step = top <= 4 ? 1 : Math.pow(10, Math.floor(Math.log10(top/2))), nice = [1, 2, 5, 10].map((k) => k*step).filter((v) => top/v <= 4)[0] || step*10, max = Math.ceil(top/nice)*nice, y = (v) => T + ph - v/max*ph, peak = days.reduce((a, x) => x[key] > a[key] ? x : a, days[0]);
    let g = ''; for (let v = 0; v <= max + 1e-9; v += nice) g += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v).toFixed(1) + '" y2="' + y(v).toFixed(1) + '"/><text class="tick" x="' + (L - 6) + '" y="' + (y(v) + 3.5).toFixed(1) + '" text-anchor="end">' + v + '</text>';
    days.forEach((x, i) => { const cx = L + band*(i + 0.5), x0 = cx - bw/2, v = x[key], h = v/max*ph, r = Math.min(4, h), yt = T + ph - h;
      if (v > 0) g += '<path class="bar" d="M' + x0.toFixed(1) + ',' + (T + ph) + 'V' + (yt + r).toFixed(1) + 'Q' + x0.toFixed(1) + ',' + yt.toFixed(1) + ' ' + (x0 + r).toFixed(1) + ',' + yt.toFixed(1) + 'H' + (x0 + bw - r).toFixed(1) + 'Q' + (x0 + bw).toFixed(1) + ',' + yt.toFixed(1) + ' ' + (x0 + bw).toFixed(1) + ',' + (yt + r).toFixed(1) + 'V' + (T + ph) + 'Z"/>';
      if (v > 0 && (x === peak || x.age === 0)) g += '<text class="val" x="' + cx.toFixed(1) + '" y="' + (yt - 4).toFixed(1) + '" text-anchor="middle">' + v + '</text>';
      if (i % 3 === 1) g += '<text class="tick" x="' + cx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + date(x.d) + '</text>';
      g += '<rect class="hit" tabindex="0" x="' + (L + band*i).toFixed(1) + '" y="' + T + '" width="' + band.toFixed(1) + '" height="' + ph + '" data-tip="' + date(x.d) + ' · ' + v + ' ' + unit + '"><title>' + date(x.d) + ': ' + v + ' ' + unit + '</title></rect>'; });
    return '<figure><figcaption>' + title + '</figcaption><svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + title + ' по дням за две недели">' + g + '<line class="axis" x1="' + L + '" x2="' + (W - R) + '" y1="' + (T + ph) + '" y2="' + (T + ph) + '"/></svg></figure>'; };
  const meter = (a, b, due) => !due ? '<td class="dim">…</td>' : b > 0 ? '<td><span class="pc">' + share(a, b) + '%</span><i class="m"><u style="width:' + share(a, b) + '%"></u></i></td>' : '<td class="dim">—</td>';
  const table = (head, rows, empty) => '<div class="scroll"><table><thead><tr>' + head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + (rows.length ? rows.join('') : '<tr><td class="dim" colspan="' + head.length + '">' + empty + '</td></tr>') + '</tbody></table></div>';
  const stamp = (at) => { const t = new Date((at + 5*3600)*1000); return String(t.getUTCDate()).padStart(2, '0') + '.' + String(t.getUTCMonth() + 1).padStart(2, '0') + ' ' + String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0'); };
  const srcMax = Math.max(1, ...st.sources.map((r) => r.n)), SRC = { direct: 'без метки', ref: 'приглашение друга', group: 'кнопка бота в группе', challenge: 'вызов «обгони моё время»', room: 'ссылка на комнату', bot_online: 'бот: онлайн-гонка', bot_friends: 'бот: гонка с друзьями' };
  return '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Turbo Drift — статистика</title><style>' +
    ':root{color-scheme:light dark;--surface:#fcfcfb;--card:#ffffff;--line:#e4e3de;--text:#0b0b0b;--text2:#52514e;--muted:#8a8982;--series:#2a78d6;--track:#ecebe6}' +
    '@media(prefers-color-scheme:dark){:root{--surface:#1a1a19;--card:#232322;--line:#383835;--text:#f0efec;--text2:#c3c2b7;--muted:#8f8e86;--series:#3987e5;--track:#30302e}}' +
    '*{box-sizing:border-box}body{margin:0;padding:20px 16px 40px;background:var(--surface);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:1080px;margin:0 auto}' +
    'header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}h1{font-size:22px;margin:0}header span{color:var(--text2);font-size:13px}header a{color:var(--text);font-size:13px;text-decoration:none;border:1px solid var(--line);border-radius:8px;padding:5px 12px}' +
    'h2{font-size:15px;margin:26px 0 8px}p.note{color:var(--text2);font-size:13px;margin:8px 0 0;max-width:760px}code{font-size:12.5px;background:var(--track);padding:1px 5px;border-radius:5px}' +
    '.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:10px}.tile{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}.tile span{font-size:12.5px;color:var(--text2)}.tile b{font-size:28px;line-height:1.15;font-weight:700;font-variant-numeric:tabular-nums}.tile small{font-size:12px;color:var(--muted);min-height:17px}' +
    '.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin-top:10px}figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 12px 6px}figcaption{font-size:13px;font-weight:600;margin-bottom:2px}svg{display:block;width:100%;height:auto;overflow:visible}' +
    '.bar{fill:var(--series)}.grid{stroke:var(--line);stroke-width:1}.axis{stroke:var(--muted);stroke-width:1}.tick{fill:var(--muted);font-size:10px}.val{fill:var(--text);font-size:11px;font-weight:600}.hit{fill:transparent;outline:none}.hit:hover,.hit:focus{fill:var(--text);fill-opacity:.07}' +
    '.scroll{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:7px 12px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--line)}tbody tr:last-child td{border-bottom:0}th{font-size:12px;font-weight:600;color:var(--text2)}td:first-child,th:first-child{text-align:left}td.dim{color:var(--muted)}tr.now td:first-child{font-weight:700}' +
    '.pc{display:inline-block;min-width:38px}.m{display:inline-block;vertical-align:middle;width:56px;height:6px;border-radius:3px;background:var(--track);margin-left:8px;overflow:hidden}.m u{display:block;height:100%;background:var(--series);border-radius:3px}.w .m{width:120px}' +
    '#tip{position:fixed;z-index:9;pointer-events:none;background:var(--text);color:var(--surface);font-size:12.5px;padding:4px 9px;border-radius:7px;transform:translate(-50%,-130%);white-space:nowrap;display:none}' +
    '</style><main><header><h1>Turbo Drift — статистика</h1><span>дни по Ташкенту · счёт идёт с выкладки этой версии сервера</span><a href="">Обновить</a></header>' +
    '<div class="tiles">' + tile('Игроков всего', st.total.players | 0, 'новых с начала счёта: ' + (st.total.fresh | 0)) + tile('Новых сегодня', today.n, 'вчера: ' + yest.n) + tile('Играло сегодня', today.dau, 'вчера: ' + yest.dau) + tile('Заездов сегодня', today.races, 'вчера: ' + yest.races) +
      tile('Возврат на 1-й день', d1 === null ? '—' : d1 + '%', d1 === null ? 'появится завтра' : 'новички за 2 недели') + tile('Возврат на 7-й день', d7 === null ? '—' : d7 + '%', d7 === null ? 'появится через неделю' : 'кому уже есть 7 дней') + tile('Групп с ботом', st.groups, 'с рекордами: ' + recs + ' игроков') + '</div>' +
    '<div class="charts">' + chart('Играло в день', 'dau', 'игроков') + chart('Новых игроков в день', 'n', 'новых') + chart('Заездов в день', 'races', 'заездов') + '</div>' +
    '<h2>По дням</h2>' + table(['День', 'Новых', 'Играло', 'Заездов', 'Вернулись на 1-й день', 'на 3-й', 'на 7-й', 'хоть раз'], days.slice().reverse().map((x) => '<tr' + (x.age === 0 ? ' class="now"' : '') + '><td>' + date(x.d) + (x.age === 0 ? ' · сегодня' : '') + '</td><td>' + x.n + '</td><td>' + x.dau + '</td><td>' + x.races + '</td>' + meter(x.r1, x.n, x.age >= 1) + meter(x.r3, x.n, x.age >= 3) + meter(x.r7, x.n, x.age >= 7) + meter(x.ever, x.n, x.age >= 1) + '</tr>'), '') +
    '<p class="note">Возврат считается от новичков этого дня: какая их доля снова открыла игру через день, через три и через семь. «…» — срок ещё не подошёл, «—» — новичков в этот день не было.</p>' +
    '<h2>Откуда пришли новички</h2>' + table(['Источник', 'Новых', 'Вернулись на 1-й день', 'Заездов на игрока'], st.sources.map((r) => '<tr><td>' + esc(SRC[r.src] || r.src || 'без метки') + (SRC[r.src] ? '' : ' <span class="dim" style="color:var(--muted)">· своя метка</span>') + '</td><td class="w"><span class="pc">' + r.n + '</span><i class="m"><u style="width:' + Math.round(r.n*100/srcMax) + '%"></u></i></td>' + meter(r.r1, r.base, r.base > 0) + '<td>' + (r.n ? (r.races/r.n).toFixed(1) : '0') + '</td></tr>'), 'Новичков пока не было') +
    '<p class="note">Своя метка задаётся ссылкой <code>https://t.me/TurboDriftBot/play?startapp=src_метка</code> — латиница, цифры, дефис. Ставь разную метку на каждый пост или рекламу и сравнивай строки.</p>' +
    '<h2>Игроки: монеты и машины</h2>' + table(['Игрок', 'Монет', 'Машины', 'Гараж стоит', 'Заездов', 'Пришёл', 'Был'], (st.players || []).map((r) => { let own = []; try { own = JSON.parse(r.owned) || []; } catch (e) {} const paid = own.filter((t) => CAR_INFO[t] && CAR_INFO[t][1] > 0).sort((a, b) => CAR_INFO[b][1] - CAR_INFO[a][1]), worth = paid.reduce((t, c) => t + CAR_INFO[c][1], 0);
      return '<tr><td>' + esc(r.name || 'ID ' + r.uid) + (r.name ? ' <span style="color:var(--muted)">· ' + r.uid + '</span>' : '') + '</td><td>' + r.coins + '</td><td style="text-align:left;white-space:normal">' + (paid.length ? esc(paid.map((t) => CAR_INFO[t][0]).join(', ')) : '<span style="color:var(--muted)">только стартовые</span>') + '</td><td>' + worth + '</td><td>' + (r.races === null || r.races === undefined ? '<span style="color:var(--muted)">—</span>' : r.races) + '</td><td>' + (r.d0 ? (r.old ? 'до ' : '') + date(r.d0) + (r.src && r.src !== 'old' ? ' · ' + esc(SRC[r.src] || r.src) : '') : '<span style="color:var(--muted)">—</span>') + '</td><td>' + stamp(r.at) + '</td></tr>'; }), 'Игроков пока нет') +
    '<p class="note">По убыванию монет, первые 200. «Гараж стоит» — сумма цен купленных машин; тюнинг и стейджи сюда не входят. «Заездов» считается с выкладки этой версии: много монет и дорогих машин при малом числе заездов — повод посмотреть на список ниже.</p>' +
    '<h2>Крупные начисления и отказы</h2>' + table(['Когда', 'Игрок', 'Прибавилось', 'Стало', 'Как'], (st.jumps || []).map((r) => '<tr><td>' + stamp(r.at) + '</td><td>' + esc(r.name || 'ID ' + r.uid) + '</td><td>' + (r.d > 0 ? '+' + r.d : '—') + '</td><td>' + r.coins + '</td><td>' + esc(r.how || '') + '</td></tr>'), 'С выкладки этой версии крупных начислений не было') +
    '<p class="note">Сюда попадает прибавка от ' + JUMP + ' монет за одно сохранение — столько не дают ни заезд, ни задания, ни приз турнира. «Срезано» — игра заявила доход быстрее, чем его можно наездить (больше ' + RATE*60 + ' монет в минуту): лишнее не зачтено. «Не прошла» — на покупку по ценам сервера не хватило монет. «Не принято» — устройство, которое сервер видит впервые, прислало кошелёк больше разрешённого.</p>' +
    '<h2>Приглашения</h2>' + table(['Игрок (Telegram ID)', 'Привёл друзей'], st.refs.map((r) => '<tr><td>' + esc(r.ref) + '</td><td>' + r.n + '</td></tr>'), 'По приглашениям пока никто не пришёл') +
    '<h2>Запуски бота по меткам ?start=</h2>' + table(['Метка', 'Запусков'], starts.map((r) => '<tr><td>' + esc(r.k) + '</td><td>' + r.n + '</td></tr>'), 'Запусков пока не было') +
    '<p class="note">Это нажатия «Запустить» в чате с ботом по ссылке <code>t.me/TurboDriftBot?start=метка</code>; игроки считаются выше.</p></main><div id="tip"></div>' +
    '<script>(function(){var t=document.getElementById("tip");function show(e){var el=e.target;if(!el.getAttribute||!el.getAttribute("data-tip"))return;var r=el.getBoundingClientRect();t.textContent=el.getAttribute("data-tip");t.style.left=(r.left+r.width/2)+"px";t.style.top=(e.clientY||r.top+20)+"px";t.style.display="block"}function hide(){t.style.display="none"}' +
    'document.addEventListener("mousemove",function(e){if(e.target.getAttribute&&e.target.getAttribute("data-tip"))show(e);else hide()});document.addEventListener("focusin",show);document.addEventListener("focusout",hide);document.addEventListener("touchstart",function(e){if(e.target.getAttribute&&e.target.getAttribute("data-tip"))show({target:e.target,clientY:e.touches[0].clientY});else hide()},{passive:true})})();</script></html>';
}
async function save(env, q) {
  const me = await whoIs(q.init, env); if (!me) return json({ ok: false, err: 'auth' }, 401);
  const cars = (a) => { const r = []; if (Array.isArray(a)) for (const t of a.slice(0, 64)) if (Number.isInteger(t) && t >= 0 && t < CARS && r.indexOf(t) < 0) r.push(t); return r; };
  const num = (v) => Math.max(-COINS_MAX, Math.min(COINS_MAX, Math.round(+v) || 0)), clamp = (v) => Math.max(0, Math.min(COINS_MAX, v));
  const row = await withSave(env, () => env.DB.prepare('SELECT coins, owned, best, prog, look, tx, bud, at FROM save WHERE uid = ?').bind(me.id).first());
  let coins = 0, owned = [3], best = {}, prog = {}, look = null, fresh = !row, txs = [];
  // A batch of changes carries a label. The game sends the same batch again when it got no answer; the label tells that it has been counted already.
  if (row && row.tx) { try { txs = JSON.parse(row.tx).filter((x) => typeof x === 'string').slice(-12); } catch (e) { txs = []; } }
  const tx = typeof q.tx === 'string' && /^[a-z0-9]{6,24}$/.test(q.tx) ? q.tx : '', seen = !!tx && txs.indexOf(tx) >= 0, before = row ? row.coins | 0 : 0; if (tx && !seen) txs.push(tx);
  if (row) { coins = row.coins | 0; try { owned = cars(JSON.parse(row.owned)); } catch (e) {} try { best = JSON.parse(row.best) || {}; } catch (e) { best = {}; } try { prog = progJoin({}, JSON.parse(row.prog || '{}')); } catch (e) { prog = {}; } }
  const old = !!row && (row.bud === null || row.bud === undefined || row.bud === '');          // a record from before the server kept the till: what that player's game holds is taken over once, as it stands
  progJoin(prog, old ? q.prog : progFree(q.prog));
  let st = { bonus: 0, refs: 0 }; try { st = await track(env, me.id, fresh, q, me.name); } catch (e) {}          // the count must never stand in the way of the save itself
  { const now = Date.now(); if (row && row.look) { try { look = lookClean(JSON.parse(row.look), now); } catch (e) { look = null; } } const mine = lookClean(q.look, now); if (mine && (!look || mine.t > look.t)) look = mine; }
  // A device that has never talked to the server sends its whole purse. It is believed only a little: a newcomer may bring a small sum and the two
  // free cars; for a player the server already knows, the server's own record stands and the device takes it over. What was not accepted is written down.
  let refused = '', denied = false; const nowS = Math.floor(Date.now()/1000);
  let bud = Math.min(BUD_MAX, (row ? (old ? BUD_MAX : Math.max(0, row.bud | 0)) : BUD_NEW) + (row ? Math.max(0, nowS - (row.at | 0))*RATE : 0));
  if (q.first && typeof q.first === 'object') { const fc = clamp(num(q.first.coins)), fo = cars(q.first.owned), extra = fo.filter((t) => t !== 0 && owned.indexOf(t) < 0);          // the coupe in the list of an old game is no claim: it used to be free
    if (fresh) { coins = Math.min(fc, FIRST_MAX); bud = BUD_NEW; }
    if (fc - coins >= JUMP || extra.length) refused = (fresh ? 'не принято у новичка: ' : 'не принято с нового устройства: ') + fc + ' монет' + (extra.length ? ', машины № ' + extra.join(', ') : ''); }
  else if (!seen) { const sh = shop(prog, q.prog, owned, cars(q.buy).filter((t) => t !== 0 || (q.v | 0) >= 108)),          // a game from before the coupe had a price puts it in every list of its own accord: that is not a purchase
       claim = num(q.d) + sh.cost, inc = Math.max(old ? -coins : 0, Math.min(claim, bud));          // claim: what the game says was earned; the spending is taken off below by the server's own prices
    bud -= Math.max(0, inc); coins = clamp(coins + inc); if (claim - inc >= 300) refused = 'срезано: заявлен доход ' + claim + ', принято ' + inc;
    { if (coins >= sh.cost) { coins -= sh.cost; Object.assign(prog, sh.prog); for (const t of sh.cars) owned.push(t); } else { denied = true; refused = (refused ? refused + '; ' : '') + 'покупка на ' + sh.cost + ' не прошла: монет ' + coins; } } }
  if (st.bonus > 0) coins = clamp(coins + st.bonus);          // came by a friend's link: the newcomer's share
  for (const t of [3]) if (owned.indexOf(t) < 0) owned.push(t);          // the hatchback is everybody's; the coupe (0) was free once and stays with those who had it then
  if (q.best && typeof q.best === 'object') { let n = 0; for (const k in q.best) { if (++n > 300) break; const ms = Math.round(+q.best[k]); if (!/^[a-z0-9]{1,8}$/.test(k) || !(ms >= 20000 && ms <= MAX_MS)) continue; if (!best[k] || ms < best[k]) best[k] = ms; } }
  const keys = Object.keys(best); if (keys.length > 400) best = Object.fromEntries(keys.slice(0, 400).map((k) => [k, best[k]]));
  await env.DB.prepare('INSERT INTO save (uid, coins, owned, best, at, prog, look, tx, bud) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT (uid) DO UPDATE SET coins = MAX(0, MIN(' + COINS_MAX + ', save.coins + ?10)), owned = excluded.owned, best = excluded.best, at = excluded.at, prog = excluded.prog, look = excluded.look, tx = excluded.tx, bud = excluded.bud')          // the purse moves by the difference: a stake paid meanwhile is not written over
    .bind(me.id, coins, JSON.stringify(owned), JSON.stringify(best), nowS, JSON.stringify(prog), look ? JSON.stringify(look) : null, JSON.stringify(txs.slice(-12)), Math.round(bud), coins - before).run();
  if (refused) { try { await withStat(env, () => env.DB.prepare('INSERT INTO jump (uid, at, d, coins, how) VALUES (?1, ?2, 0, ?3, ?4)').bind(me.id, Math.floor(Date.now()/1000), coins, refused.slice(0, 120)).run()); } catch (e) {} }
  if (coins - before - st.bonus >= JUMP) { try { await withStat(env, () => env.DB.prepare('INSERT INTO jump (uid, at, d, coins, how) VALUES (?1, ?2, ?3, ?4, ?5)').bind(me.id, Math.floor(Date.now()/1000), coins - before - st.bonus, coins, q.first ? (fresh ? 'первый вход' : 'новое устройство') : 'за раз').run()); } catch (e) {} }          // far more than a race pays: kept for the owner to look at
  return json({ ok: true, coins: coins, owned: owned, best: best, prog: prog, look: look, bonus: st.bonus, refs: st.refs, denied: denied });
}

// A race for a stake. The host opens the bank with his own stake before the start; every other player pays in as the race begins. The coins leave
// the purses here, on the server. When the first car is home the host names the winner — who must be one of those who paid — and the whole bank
// goes to him. A bank nobody was named for gives the stakes back after a quarter of an hour.
const STAKES = [100, 250, 500, 1000, 2000, 2500, 5000], POT_HOLD = 900;
async function withPot(env, work) {
  try { return await work(); } catch (e) { if (!/no such table/i.test(String(e && e.message || e))) throw e;
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS pot (pid TEXT NOT NULL, uid INTEGER NOT NULL, sum INTEGER NOT NULL, at INTEGER NOT NULL, host INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (pid, uid))').run(); return await work(); }
}
async function pot(env, q) {
  const me = await whoIs(q.init, env); if (!me) return json({ ok: false, err: 'auth' }, 401);
  const pid = String(q.pid || ''), now = Math.floor(Date.now()/1000); if (!/^[a-z0-9]{10,24}$/.test(pid)) return json({ ok: false, err: 'range' }, 400);
  const purse = async () => { const r = await withSave(env, () => env.DB.prepare('SELECT coins FROM save WHERE uid = ?').bind(me.id).first()); return r ? r.coins | 0 : 0; };
  if (q.op === 'pay') { const stake = q.stake | 0; if (STAKES.indexOf(stake) < 0) return json({ ok: false, err: 'range' }, 400);
    const mine = await withPot(env, () => env.DB.prepare('SELECT sum FROM pot WHERE pid = ? AND uid = ?').bind(pid, me.id).first()); if (mine) return json({ ok: true, paid: mine.sum | 0, coins: await purse() });          // asked again after an answer that got lost: paid once
    const open = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM pot WHERE pid = ?').bind(pid).first()) || {}).n | 0;
    if (q.host ? open > 0 : open === 0) return json({ ok: false, err: 'pot', coins: await purse() });          // the host is the one who opens it; nobody pays into a bank that is not open
    const ins = await env.DB.prepare('INSERT OR IGNORE INTO pot (pid, uid, sum, at, host) VALUES (?1, ?2, ?3, ?4, ?5)').bind(pid, me.id, stake, now, q.host ? 1 : 0).run();
    if (ins && ins.meta && ins.meta.changes) { const up = await withSave(env, () => env.DB.prepare('UPDATE save SET coins = coins - ?1 WHERE uid = ?2 AND coins >= ?1').bind(stake, me.id).run());
      if (!(up && up.meta && up.meta.changes)) { await env.DB.prepare('DELETE FROM pot WHERE pid = ? AND uid = ?').bind(pid, me.id).run(); return json({ ok: false, err: 'coins', coins: await purse() }); } }
    return json({ ok: true, paid: stake, coins: await purse() }); }
  if (q.op === 'win') { const w = Math.round(+q.uid), h = await withPot(env, () => env.DB.prepare('SELECT host FROM pot WHERE pid = ? AND uid = ?').bind(pid, me.id).first());
    if (!h || !h.host) return json({ ok: false, err: 'host' }); if (!Number.isSafeInteger(w) || !(await env.DB.prepare('SELECT 1 AS x FROM pot WHERE pid = ? AND uid = ?').bind(pid, w).first())) return json({ ok: false, err: 'winner' });
    const tot = ((await env.DB.prepare('SELECT COALESCE(SUM(sum), 0) AS s FROM pot WHERE pid = ?').bind(pid).first()) || {}).s | 0, del = await env.DB.prepare('DELETE FROM pot WHERE pid = ?').bind(pid).run();
    if (del && del.meta && del.meta.changes && tot > 0) await env.DB.prepare('UPDATE save SET coins = MIN(?, coins + ?) WHERE uid = ?').bind(COINS_MAX, tot, w).run();
    return json({ ok: true, sum: tot, coins: await purse() }); }
  if (q.op === 'back') { const r = await withPot(env, () => env.DB.prepare('SELECT sum, at FROM pot WHERE pid = ? AND uid = ?').bind(pid, me.id).first());
    if (!r) return json({ ok: true, none: true, coins: await purse() }); const n = ((await env.DB.prepare('SELECT COUNT(*) AS n FROM pot WHERE pid = ?').bind(pid).first()) || {}).n | 0;          // alone in the bank: nobody to race for it, the stake goes back at once
    if (n > 1 && now - (r.at | 0) < POT_HOLD) return json({ ok: false, err: 'wait', left: POT_HOLD - (now - (r.at | 0)) });
    const del = await env.DB.prepare('DELETE FROM pot WHERE pid = ? AND uid = ?').bind(pid, me.id).run();
    if (del && del.meta && del.meta.changes) await env.DB.prepare('UPDATE save SET coins = MIN(?, coins + ?) WHERE uid = ?').bind(COINS_MAX, r.sum | 0, me.id).run();
    return json({ ok: true, back: r.sum | 0, coins: await purse() }); }
  return json({ ok: false, err: 'op' }, 400);
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
const BOT_COMMANDS = [{ command: 'play', description: 'Открыть игру' }, { command: 'race', description: 'Приватная комната: только для этого чата' }, { command: 'online', description: 'Онлайн-гонка со случайными соперниками' }, { command: 'top', description: 'Турнир недели: лучшие времена' }, { command: 'stop', description: 'Не присылать итоги недели в этот чат' }, { command: 'help', description: 'Что умеет бот' }];
const fmtMs = (ms) => { const m = Math.floor(ms/60000), s = Math.floor(ms % 60000/1000), c = Math.floor(ms % 1000/10); return m + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0'); };
async function weekText(env) {
  const wk = weekNow(), ti = weekTrack(wk); let rows = [];
  try { rows = (await withWeek(env, () => env.DB.prepare('SELECT name, ms FROM week WHERE wk = ? ORDER BY ms ASC, at ASC LIMIT 10').bind(wk).all())).results || []; } catch (e) {}
  const left = Math.max(0, wk*WEEK_S - 3*86400 + WEEK_S - Date.now()/1000), d = Math.floor(left/86400), h = Math.floor(left % 86400/3600);
  return '🏆 Турнир недели — трасса «' + TRACK_NAMES[ti] + '»\n' + (rows.length ? rows.map((r, i) => (i + 1) + '. ' + r.name + ' — ' + fmtMs(r.ms)).join('\n') : 'Пока никто не проехал. Будь первым!') + '\n\nДо конца: ' + (d ? d + ' д ' : '') + h + ' ч. Призы: до 3000 монет.';
}
// Mondays: every group that uses the bot is told how last week's tournament ended and which track the new week is on. A group is written
// to once a week; one that has thrown the bot out is forgotten. Runs from a cron trigger, a hundred groups at a time.
async function weekPost(env) {
  const wk = weekNow(), bot = env.BOT_NAME || 'TurboDriftBot', app = env.APP_NAME || 'play', link = 'https://t.me/' + bot + '/' + app, out = { sent: 0, gone: 0, failed: 0 };
  let rows = [], groups = [];
  try { rows = (await withWeek(env, () => env.DB.prepare('SELECT name, ms FROM week WHERE wk = ? ORDER BY ms ASC, at ASC LIMIT 5').bind(wk - 1).all())).results || []; } catch (e) {}
  try { groups = (await withStat(env, () => env.DB.prepare('SELECT chat FROM grp WHERE week < ? ORDER BY at DESC LIMIT 100').bind(wk).all())).results || []; } catch (e) {}
  const text = (rows.length ? '🏆 Итоги недели в Turbo Drift — трасса «' + TRACK_NAMES[weekTrack(wk - 1)] + '»\n' + rows.map((r, i) => (i + 1) + '. ' + r.name + ' — ' + fmtMs(r.ms)).join('\n') + '\n\n' : '') +
    '🏁 Новая неделя: турнир на трассе «' + TRACK_NAMES[weekTrack(wk)] + '». Лучшее время недели получает 3000 монет.\n\n/race — гонка этим чатом · /top — таблица · /stop — не присылать итоги';
  for (const g of groups) { let ok = false, code = 0;
    try { const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: g.chat, text: text, reply_markup: { inline_keyboard: [[{ text: '🏁 Играть', url: link }]] } }) });
      code = r.status; let j = null; try { j = await r.json(); } catch (e) {} ok = !!(j && j.ok); } catch (e) {}
    if (ok) { out.sent++; await env.DB.prepare('UPDATE grp SET week = ? WHERE chat = ?').bind(wk, g.chat).run(); }
    else if (code === 403 || code === 400) { out.gone++; await env.DB.prepare('DELETE FROM grp WHERE chat = ?').bind(g.chat).run(); }          // thrown out of the group, or the group is no more
    else out.failed++; }
  return out;
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
  if (!priv && (m.chat.type === 'group' || m.chat.type === 'supergroup') && ['play', 'start', 'race', 'room', 'online', 'top', 'help', 'stop'].indexOf(cmd) >= 0) {          // a group that uses the bot gets the results of the week on Mondays; /stop turns that off
    try { await withStat(env, () => env.DB.prepare(cmd === 'stop' ? 'INSERT INTO grp (chat, title, at, week) VALUES (?1, ?2, ?3, 999999) ON CONFLICT (chat) DO UPDATE SET week = 999999' : 'INSERT INTO grp (chat, title, at, week) VALUES (?1, ?2, ?3, 0) ON CONFLICT (chat) DO UPDATE SET title = excluded.title, at = excluded.at, week = CASE WHEN ?4 = 1 AND grp.week = 999999 THEN 0 ELSE grp.week END')
      .bind(...(cmd === 'stop' ? [m.chat.id, String(m.chat.title || '').slice(0, 64), Math.floor(Date.now()/1000)] : [m.chat.id, String(m.chat.title || '').slice(0, 64), Math.floor(Date.now()/1000), cmd === 'top' ? 1 : 0])).run()); } catch (e) {} }
  if (cmd === 'stop' && !priv) { await send({ text: 'Хорошо, итоги недели в этот чат присылать не буду. Вернуть: /top' }); return new Response('ok'); }
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
      if (path === '/top' || path === '/score' || path === '/save' || path === '/week' || path === '/pot') {
        let q = {}; if (request.method === 'POST') { const t = await request.text(); if (t.length > (path === '/save' ? 20000 : 6000)) return json({ ok: false, err: 'big' }, 413); try { q = JSON.parse(t) || {}; } catch (e) { return json({ ok: false, err: 'json' }, 400); } }
        else q = { track: url.searchParams.get('track') };
        if (path === '/score') return request.method === 'POST' ? await score(env, q, request) : json({ ok: false, err: 'method' }, 405);
        if (path === '/save') return request.method === 'POST' ? await save(env, q) : json({ ok: false, err: 'method' }, 405);
        if (path === '/week') return request.method === 'POST' ? await week(env, q) : json({ ok: false, err: 'method' }, 405);
        if (path === '/pot') return request.method === 'POST' ? await pot(env, q) : json({ ok: false, err: 'method' }, 405);
        const track = q.track | 0; if (!(track >= 0 && track < TRACKS)) return json({ ok: false, err: 'range' }, 400);
        return json(await board(env, track, await whoIs(q.init, env)));
      }
      if (path === '/setup' || path === '/stats' || path === '/weekpost') {
        if (!env.HOOK_SECRET || url.searchParams.get('key') !== env.HOOK_SECRET) return json({ ok: false, err: 'key' }, 403);
        if (path === '/setup') return json(Object.assign({ ok: true }, await setup(env, url.origin)));
        if (path === '/weekpost') return json(Object.assign({ ok: true }, await weekPost(env)));
        let src = [], pl = null; try { src = (await env.DB.prepare('SELECT k, n FROM src ORDER BY n DESC LIMIT 100').all()).results || []; pl = await env.DB.prepare('SELECT COUNT(DISTINCT uid) AS n FROM best').first(); } catch (e) {}
        const st = await stats(env); if (url.searchParams.get('json')) return json(Object.assign({ starts: src, players_with_records: pl ? pl.n : 0 }, st));
        return new Response(statsPage(st, src, pl ? pl.n : 0), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
      if (path === '/') return json({ ok: true, name: 'Turbo Drift', db: !!env.DB, token: !!env.BOT_TOKEN, key: !!env.HOOK_SECRET });
      return json({ ok: false, err: 'path' }, 404);
    } catch (e) { return json({ ok: false, err: 'server', msg: String(e && e.message || e).slice(0, 200) }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(weekPost(env).catch(() => {})); }          // the cron trigger: Monday morning
};
