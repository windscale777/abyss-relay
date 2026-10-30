/* 深淵の刻印 — マルチプレイ用の中継サーバー(abyss-relay) v4
 *   ・ワールド(合言葉)ごとに最大 MAX_PLAYERS 人。町では全員が見える。ワールドはリーグ(永続 / その月のシーズン)ごとに別
 *   ・ワールドの中でパーティー(最大 PARTY_MAX 人)を組むと、エリアを一緒に攻略できる。パーティーのリーダーのゲームが敵を動かす
 *   ・トレード: 2人が出す物を決めて、両方が OK すると中身を交換する(サーバーが仲立ちする)
 *   ・チャット: ワールド全体 / パーティーだけ
 *   ・開発者: Render の Environment の DEV_USERS(カンマ区切りのID)に書いたアカウントは、ゲームの開発者メニューと Excel が使える
 *   ゲームの計算はしません。受け取ったメッセージを渡すだけです。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 32);
const PARTY_MAX = Number(process.env.PARTY_MAX || 4);
const SEASON_TZ = Number(process.env.SEASON_TZ || 9);   // シーズンが切り替わる時差(9 = 日本時間の毎月1日0時)
const DEV_USERS = new Set(String(process.env.DEV_USERS || '').split(',').map(s => s.trim().normalize('NFKC').toLowerCase()).filter(Boolean));
const MAX_MSG = 512 * 1024;
const TRADE_MAX_ITEMS = 80;
const rooms = new Map();     // リーグ:ワールド名 → { code, league, members: Map(id → ws), parties: Map(パーティー名 → { name, members: [id] }) }
const trades = new Map();    // トレード番号 → { id, a, b, items: Map(id → [アイテム]), ok: Map(id → true), ver }
let nextId = 1, nextTrade = 1;
/** いまのシーズン: '2026-11' */
function seasonKeyNow() { const d = new Date(Date.now() + SEASON_TZ * 3600000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
const isDev = user => !!user && DEV_USERS.has(user);
/* ---------- 古い版のゲームを断る ----------
 *   新しい版のゲームは、ログイン・セーブでは X-Game-Version ヘッダー、ワールドでは join の ver に版を付けてくる。
 *   版がない・MIN_GAME_VERSION より古いものは断る(古い形のセーブで新しいセーブを上書きしないように) */
const MIN_GAME_VERSION = String(process.env.MIN_GAME_VERSION || '2.13.0');
const vnum = s => String(s || '0').split('.').map(x => parseInt(x, 10) || 0).reduce((a, b) => a * 1000 + b, 0);
const OLD_MSG = `このゲームは古い版です。https://abyss-relay.onrender.com をブラウザで開いて遊んでください(ログインすれば、セーブはそのまま続きから使えます)`;
const oldGame = v => !v || vnum(v) < vnum(MIN_GAME_VERSION);

/* ============================================================
 * 保存先(アカウントとセーブ)
 *   Render の「Environment」に UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN があれば Upstash(無料・消えない)
 *   なければサーバーのファイル(無料プランでは、サーバーが入れ替わると消える)
 * ============================================================ */
/** 貼りまちがいを直す: 前後の空白・引用符、https:// のつけ忘れ、redis://〜(接続用の文字)を貼った場合 */
function fixKv() {
  let url = String(process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/^["']|["']$/g, '').trim();
  let token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim().replace(/^["']|["']$/g, '').trim();
  const m = /^rediss?:\/\/(?:[^:@\/]*:)?([^@\/]+)@([^:\/]+)(?::\d+)?/i.exec(url);   // rediss://default:TOKEN@host:6379
  if (m) { if (!token) token = m[1]; url = 'https://' + m[2]; }
  url = url.replace(/^UPSTASH_REDIS_REST_URL\s*=\s*/i, '').replace(/:\d+\/?$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  token = token.replace(/^UPSTASH_REDIS_REST_TOKEN\s*=\s*/i, '');
  return { url: url.replace(/\/+$/, ''), token };
}
const { url: KV_URL, token: KV_TOKEN } = fixKv();
let kvCheck = { ok: null, msg: '' };
const FILE_DB = path.join(__dirname, 'data.json');
let fileDb = null;
function fileLoad() { if (!fileDb) { try { fileDb = JSON.parse(fs.readFileSync(FILE_DB, 'utf8')); } catch (e) { fileDb = {}; } } return fileDb; }
let fileSaveT = null;
function fileSave() { clearTimeout(fileSaveT); fileSaveT = setTimeout(() => { try { fs.writeFileSync(FILE_DB, JSON.stringify(fileDb)); } catch (e) { console.error(e); } }, 500); }
async function kv(cmd) {
  if (KV_URL) {
    const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
  }
  const db = fileLoad(), [op, key, val] = cmd, now = Date.now();
  if (op === 'GET') { const e = db[key]; if (!e || (e.x && e.x < now)) return null; return e.v; }
  if (op === 'SET') { const ex = cmd[3] === 'EX' ? now + cmd[4] * 1000 : 0; db[key] = { v: val, x: ex }; fileSave(); return 'OK'; }
  if (op === 'DEL') { delete db[key]; fileSave(); return 1; }
  throw new Error('unknown op');
}
const STORAGE = KV_URL ? 'upstash' : 'file';
const TOKEN_DAYS = 90;
const hashPass = (pass, salt) => new Promise((ok, ng) => crypto.scrypt(pass, salt, 32, (e, k) => e ? ng(e) : ok(k.toString('hex'))));
const userKey = u => 'user:' + u, saveKey = u => 'save:' + u, tokKey = t => 'tok:' + t;
const cleanUser = s => String(s || '').trim().normalize('NFKC').toLowerCase();
const validUser = u => /^[a-z0-9_\-぀-ヿ㐀-鿿]{2,16}$/.test(u);
const fails = new Map();   // ログイン失敗の回数(同じ場所から何度も試されるのを防ぐ)
function tooMany(ip) { const f = fails.get(ip); return f && f.n >= 10 && Date.now() - f.t < 10 * 60 * 1000; }
function failed(ip) { const f = fails.get(ip) || { n: 0, t: 0 }; if (Date.now() - f.t > 10 * 60 * 1000) f.n = 0; f.n++; f.t = Date.now(); fails.set(ip, f); }
async function newToken(user) { const t = crypto.randomBytes(24).toString('hex'); await kv(['SET', tokKey(t), user, 'EX', TOKEN_DAYS * 86400]); return t; }
async function authUser(req) { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : ''; if (!/^[0-9a-f]{48}$/.test(t)) return null; return await kv(['GET', tokKey(t)]); }

function readBody(req, max) {
  return new Promise((ok, ng) => { let n = 0; const ch = []; req.on('data', d => { n += d.length; if (n > max) { ng(new Error('too large')); req.destroy(); } else ch.push(d); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', ng); });
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Game-Version', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }); res.end(JSON.stringify(o)); }
function status() { let players = 0; for (const r of rooms.values()) players += r.members.size; return { ok: true, name: 'abyss-relay', version: 4, now: Date.now(), minGame: MIN_GAME_VERSION, season: seasonKeyNow(), worlds: rooms.size, players, max: MAX_PLAYERS, partyMax: PARTY_MAX, trades: trades.size, devUsers: DEV_USERS.size, storage: STORAGE, storageOk: kvCheck.ok, storageMsg: kvCheck.msg, storageHost: KV_URL ? KV_URL.replace(/^https?:\/\//, '') : '', game: fs.existsSync(GAME_FILE) }; }
/** 保存先につながるか確かめる(起動時と /health を開いたとき) */
async function checkKv() {
  if (!KV_URL) { kvCheck = { ok: true, msg: 'Upstash が設定されていないので、サーバーのファイルに保存します(サーバーが入れ替わると消えます)' }; return; }
  try {
    const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(['PING']) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) kvCheck = { ok: false, msg: 'Upstash に断られました。UPSTASH_REDIS_REST_TOKEN が合っているか確かめてください' };
    else if (j.result === 'PONG') kvCheck = { ok: true, msg: 'Upstash につながっています' };
    else kvCheck = { ok: false, msg: 'Upstash から予想外の返事: ' + JSON.stringify(j).slice(0, 120) };
  } catch (e) { kvCheck = { ok: false, msg: `Upstash(${KV_URL.replace(/^https?:\/\//, '')})につながりません。UPSTASH_REDIS_REST_URL が「https://○○.upstash.io」の形か確かめてください(${e.cause && e.cause.code || e.message})` }; }
}
checkKv();
const GAME_FILE = path.join(__dirname, 'abyss-arpg.html');

async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url !== '/api/logout' && oldGame(req.headers['x-game-version'])) return json(res, 426, { error: OLD_MSG, old: true });
    if (url === '/api/register' || url === '/api/login') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST で送ってください' });
      if (tooMany(ip)) return json(res, 429, { error: '失敗が多すぎます。10分ほど待ってください' });
      const b = JSON.parse(await readBody(req, 10000) || '{}'), user = cleanUser(b.user), pass = String(b.pass || '');
      if (!validUser(user)) return json(res, 400, { error: 'IDは2〜16文字(英数字・ひらがな・カタカナ・漢字・_ -)にしてください' });
      if (pass.length < 6 || pass.length > 64) return json(res, 400, { error: 'パスワードは6〜64文字にしてください' });
      const cur = await kv(['GET', userKey(user)]);
      if (url === '/api/register') {
        if (cur) { failed(ip); return json(res, 409, { error: 'そのIDはもう使われています' }); }
        const salt = crypto.randomBytes(16).toString('hex'), hash = await hashPass(pass, salt);
        await kv(['SET', userKey(user), JSON.stringify({ salt, hash, created: Date.now() })]);
        return json(res, 200, { ok: true, user, token: await newToken(user), dev: isDev(user), now: Date.now() });
      }
      if (!cur) { failed(ip); return json(res, 401, { error: 'IDかパスワードがちがいます' }); }
      const u = JSON.parse(cur), h = await hashPass(pass, u.salt);
      if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'))) { failed(ip); return json(res, 401, { error: 'IDかパスワードがちがいます' }); }
      return json(res, 200, { ok: true, user, token: await newToken(user), dev: isDev(user), now: Date.now() });
    }
    if (url === '/api/logout') { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) await kv(['DEL', tokKey(h.slice(7))]); return json(res, 200, { ok: true }); }
    if (url === '/api/save') {
      const user = await authUser(req); if (!user) return json(res, 401, { error: 'ログインし直してください' });
      if (req.method === 'GET') { const s = await kv(['GET', saveKey(user)]); return json(res, 200, { ok: true, user, dev: isDev(user), now: Date.now(), ...(s ? JSON.parse(s) : { t: 0, data: null }) }); }
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req, 4 * 1024 * 1024) || '{}');
        if (typeof b.data !== 'string' || !(b.t > 0)) return json(res, 400, { error: 'セーブの形が正しくありません' });
        await kv(['SET', saveKey(user), JSON.stringify({ t: b.t, data: b.data, z: b.z ? 1 : 0, saved: Date.now() })]);
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); if (KV_URL && /fetch failed|ENOTFOUND|ECONN|parse URL/i.test(e.message + (e.cause ? e.cause.code : ''))) { await checkKv(); return json(res, 503, { error: 'セーブの保存先(Upstash)につながりません。' + kvCheck.msg }); } return json(res, 500, { error: 'サーバーでエラーが起きました: ' + e.message }); }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.startsWith('/api/')) return api(req, res, url);
  if ((url === '/' || url === '/index.html' || url === '/play') && fs.existsSync(GAME_FILE)) {   // ゲームそのものを配る(ブラウザで開くだけで遊べる)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(GAME_FILE).pipe(res);
  }
  if (url === '/health') return checkKv().then(() => json(res, 200, status()));
  return json(res, 200, status());
});
const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };
const cleanRoom = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
const cleanName = s => String(s || '').trim().replace(/[\u0000-\u001f<>]/g, '').slice(0, 16);

function partyList(r) { return [...r.parties.values()].map(p => ({ name: p.name, leader: p.members[0], members: p.members })); }
function sendParties(r) { const o = JSON.stringify({ t: 'parties', list: partyList(r) }); for (const p of r.members.values()) send(p, o); }
function partyOf(r, ws) { return ws.party ? r.parties.get(ws.party) : null; }
function leaveParty(r, ws) {
  const p = partyOf(r, ws); ws.party = null; if (!p) return;
  p.members = p.members.filter(id => id !== ws.id);
  if (!p.members.length) r.parties.delete(p.name);
}
/* ---------- トレード ---------- */
const TRADE_TYPES = ['equip', 'gem', 'rune', 'currency'];
const tradeOf = ws => (ws.trade ? trades.get(ws.trade) : null);
function tradeState(t) {
  for (const [me, other] of [[t.a, t.b], [t.b, t.a]]) send(me, { t: 'trade', op: 'state', tid: t.id, theirs: t.items.get(other.id) || [], okMine: !!t.ok.get(me.id), okTheirs: !!t.ok.get(other.id), ver: t.ver });
}
function endTrade(t, msg, except) {
  trades.delete(t.id);
  for (const p of [t.a, t.b]) { if (p.trade === t.id) p.trade = null; if (p !== except) send(p, { t: 'trade', op: 'closed', tid: t.id, msg }); }
}
function onTrade(r, ws, m) {
  const fail = msg => send(ws, { t: 'trade', op: 'fail', msg });
  if (m.op === 'ask') {
    const to = r.members.get(m.to);
    if (!to || to === ws) return fail('相手がワールドにいません');
    if (ws.trade) return fail('いまトレード中です');
    if (to.trade) return fail(`${to.name} はほかの人とトレード中です`);
    to.tradeAsk = { from: ws.id, at: Date.now() };
    send(to, { t: 'trade', op: 'asked', from: ws.id, name: ws.name }); send(ws, { t: 'trade', op: 'sent', name: to.name });
    return;
  }
  if (m.op === 'answer') {
    const ask = ws.tradeAsk, from = r.members.get(m.from); ws.tradeAsk = null;
    if (!ask || ask.from !== m.from || Date.now() - ask.at > 120000 || !from) return fail('申し込みの期限が切れました');
    if (!m.yes) return send(from, { t: 'trade', op: 'declined', name: ws.name });
    if (from.trade || ws.trade) return fail('どちらかがほかの人とトレード中です');
    const t = { id: nextTrade++, a: from, b: ws, items: new Map(), ok: new Map(), ver: 1 };
    trades.set(t.id, t); from.trade = ws.trade = t.id;
    send(from, { t: 'trade', op: 'open', tid: t.id, with: ws.id, name: ws.name }); send(ws, { t: 'trade', op: 'open', tid: t.id, with: from.id, name: from.name });
    return tradeState(t);
  }
  const t = tradeOf(ws); if (!t || t.id !== m.tid) return;
  if (m.op === 'offer') {   // 出す物が変わった: 両方の OK を取り消す
    const items = Array.isArray(m.items) ? m.items : null;
    if (!items || items.length > TRADE_MAX_ITEMS || !items.every(it => it && typeof it === 'object' && typeof it.uid === 'string' && TRADE_TYPES.includes(it.type))) return fail('出す物が正しくありません');
    t.items.set(ws.id, items); t.ok.clear(); t.ver++; return tradeState(t);
  }
  if (m.op === 'ok') {
    if (m.ver !== t.ver) return tradeState(t);   // 相手が中身を変えたばかり: もう一度見てもらう
    t.ok.set(ws.id, true);
    if (t.ok.get(t.a.id) && t.ok.get(t.b.id)) {   // 成立: おたがいの出した物を渡す
      trades.delete(t.id); t.a.trade = t.b.trade = null;
      send(t.a, { t: 'trade', op: 'done', tid: t.id, got: t.items.get(t.b.id) || [] });
      send(t.b, { t: 'trade', op: 'done', tid: t.id, got: t.items.get(t.a.id) || [] });
      return;
    }
    return tradeState(t);
  }
  if (m.op === 'cancel') return endTrade(t, `${ws.name} がトレードをやめました(出した物は持ち物に戻りました)`, ws);
}

wss.on('connection', ws => {
  ws.id = nextId++; ws.alive = true; ws.room = null; ws.name = ''; ws.party = null; ws.trade = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m.t === 'join') {
      if (ws.room) return;
      if (oldGame(m.ver)) return send(ws, { t: 'error', msg: OLD_MSG });
      const code = cleanRoom(m.room); if (!code) return send(ws, { t: 'error', msg: 'ワールドの合言葉が空です' });
      const league = m.league == null || m.league === 'std' ? 'std' : String(m.league);
      if (league !== 'std' && league !== seasonKeyNow()) return send(ws, { t: 'error', msg: 'このキャラのシーズンはもう終わっています。ゲームを読み込み直すと、永続リーグへ移ります' });
      const key = league + ':' + code;
      let r = rooms.get(key);
      if (!r) { r = { code, league, members: new Map(), parties: new Map() }; rooms.set(key, r); }
      if (r.members.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: `このワールドはいっぱいです(${MAX_PLAYERS}人まで)` });
      ws.room = key; ws.name = cleanName(m.name) || '冒険者';
      const peers = [...r.members.values()].map(p => ({ id: p.id, name: p.name, party: p.party }));
      r.members.set(ws.id, ws);
      send(ws, { t: 'welcome', id: ws.id, room: code, league, peers, parties: partyList(r), partyMax: PARTY_MAX });
      for (const p of r.members.values()) if (p !== ws) send(p, { t: 'peer+', id: ws.id, name: ws.name });
      return;
    }
    const r = ws.room && rooms.get(ws.room); if (!r) return;
    switch (m.t) {
      case 'party': {
        if (m.op === 'join') {
          const name = cleanName(m.name); if (!name) return send(ws, { t: 'error', soft: 1, msg: 'パーティー名を入れてください' });
          if (ws.party === name) return;
          let p = r.parties.get(name);
          if (p && p.members.length >= PARTY_MAX) return send(ws, { t: 'error', soft: 1, msg: `パーティー「${name}」はいっぱいです(${PARTY_MAX}人まで)` });
          leaveParty(r, ws);
          if (!p) { p = { name, members: [] }; r.parties.set(name, p); }
          p.members.push(ws.id); ws.party = name;
          sendParties(r);
        } else if (m.op === 'leave') { leaveParty(r, ws); sendParties(r); }
        return;
      }
      case 'r': {   // 中継: to(1人) / party(パーティー) / all(ワールド全体)
        const out = JSON.stringify({ t: 'r', from: ws.id, d: m.d });
        if (m.to) return send(r.members.get(m.to), out);
        if (m.scope === 'all') { for (const p of r.members.values()) if (p !== ws) send(p, out); return; }
        const pt = partyOf(r, ws); if (pt) for (const id of pt.members) if (id !== ws.id) send(r.members.get(id), out);
        return;
      }
      case 'chat': {
        const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200); if (!text) return;
        const scope = m.scope === 'party' && ws.party ? 'party' : 'all';
        const out = JSON.stringify({ t: 'chat', from: ws.id, name: ws.name, scope, party: ws.party, text });
        if (scope === 'all') for (const p of r.members.values()) send(p, out);
        else { const pt = partyOf(r, ws); if (pt) for (const id of pt.members) send(r.members.get(id), out); }
        return;
      }
      case 'trade': return onTrade(r, ws, m);
    }
  });
  ws.on('close', () => {
    const t = tradeOf(ws); if (t) endTrade(t, `${ws.name} がいなくなったため、トレードをやめました(出した物は持ち物に戻りました)`, ws);
    const r = ws.room && rooms.get(ws.room); if (!r) return;
    const hadParty = !!ws.party; leaveParty(r, ws);
    r.members.delete(ws.id);
    if (!r.members.size) { rooms.delete(ws.room); return; }
    for (const p of r.members.values()) send(p, { t: 'peer-', id: ws.id });
    if (hadParty) sendParties(r);
  });
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 25000);
server.listen(PORT, () => console.log(`abyss-relay v4 listening on ${PORT} (storage: ${STORAGE}, dev users: ${DEV_USERS.size})`));
