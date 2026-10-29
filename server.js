/* 深淵の刻印 — マルチプレイ用の中継サーバー(abyss-relay) v2
 *   ・ワールド(合言葉)ごとに最大 MAX_PLAYERS 人。町では全員が見える
 *   ・ワールドの中でパーティー(最大 PARTY_MAX 人)を組むと、エリアを一緒に攻略できる。パーティーのリーダーのゲームが敵を動かす
 *   ・パーティー倉庫: パーティー名ごとにアイテムを預けられる(サーバーの記憶+各自のゲームにも控え)
 *   ・チャット: ワールド全体 / パーティーだけ
 *   ゲームの計算はしません。受け取ったメッセージを渡すだけです。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 32);
const PARTY_MAX = Number(process.env.PARTY_MAX || 4);
const STASH_W = 12, STASH_H = 8;
const MAX_MSG = 512 * 1024;
const rooms = new Map();     // ワールド名 → { members: Map(id → ws), parties: Map(パーティー名 → { name, members: [id] }) }
const stashes = new Map();   // ワールド名/パーティー名 → { ver, items: [{ item, w, h }] }
let nextId = 1;

/* ============================================================
 * 保存先(アカウントとセーブ)
 *   Render の「Environment」に UPSTASH_REDIS_REST_URL と UPSTASH_REDIS_REST_TOKEN があれば Upstash(無料・消えない)
 *   なければサーバーのファイル(無料プランでは、サーバーが入れ替わると消える)
 * ============================================================ */
const KV_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
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
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
function json(res, code, o) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }); res.end(JSON.stringify(o)); }
function status() { let players = 0; for (const r of rooms.values()) players += r.members.size; return { ok: true, name: 'abyss-relay', version: 3, worlds: rooms.size, players, max: MAX_PLAYERS, partyMax: PARTY_MAX, storage: STORAGE, game: fs.existsSync(GAME_FILE) }; }
const GAME_FILE = path.join(__dirname, 'abyss-arpg.html');

async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
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
        return json(res, 200, { ok: true, user, token: await newToken(user) });
      }
      if (!cur) { failed(ip); return json(res, 401, { error: 'IDかパスワードがちがいます' }); }
      const u = JSON.parse(cur), h = await hashPass(pass, u.salt);
      if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'))) { failed(ip); return json(res, 401, { error: 'IDかパスワードがちがいます' }); }
      return json(res, 200, { ok: true, user, token: await newToken(user) });
    }
    if (url === '/api/logout') { const h = req.headers.authorization || ''; if (h.startsWith('Bearer ')) await kv(['DEL', tokKey(h.slice(7))]); return json(res, 200, { ok: true }); }
    if (url === '/api/save') {
      const user = await authUser(req); if (!user) return json(res, 401, { error: 'ログインし直してください' });
      if (req.method === 'GET') { const s = await kv(['GET', saveKey(user)]); return json(res, 200, s ? { ok: true, user, ...JSON.parse(s) } : { ok: true, user, t: 0, data: null }); }
      if (req.method === 'POST') {
        const b = JSON.parse(await readBody(req, 4 * 1024 * 1024) || '{}');
        if (typeof b.data !== 'string' || !(b.t > 0)) return json(res, 400, { error: 'セーブの形が正しくありません' });
        await kv(['SET', saveKey(user), JSON.stringify({ t: b.t, data: b.data, z: b.z ? 1 : 0, saved: Date.now() })]);
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); return json(res, 500, { error: 'サーバーでエラーが起きました: ' + e.message }); }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.startsWith('/api/')) return api(req, res, url);
  if ((url === '/' || url === '/index.html' || url === '/play') && fs.existsSync(GAME_FILE)) {   // ゲームそのものを配る(ブラウザで開くだけで遊べる)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(GAME_FILE).pipe(res);
  }
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
function stashKey(ws) { return ws.room + '/' + ws.party; }
function sendStash(r, ws, onlyTo) {
  const st = stashes.get(stashKey(ws)) || { ver: 0, items: [] };
  const o = JSON.stringify({ t: 'ps', party: ws.party, ver: st.ver, items: st.items.map(x => x.item) });
  if (onlyTo) return send(ws, o);
  const p = partyOf(r, ws); if (p) for (const id of p.members) send(r.members.get(id), o);
}
const overlap = (a, b) => a.item.gx < b.item.gx + b.w && b.item.gx < a.item.gx + a.w && a.item.gy < b.item.gy + b.h && b.item.gy < a.item.gy + a.h;

wss.on('connection', ws => {
  ws.id = nextId++; ws.alive = true; ws.room = null; ws.name = ''; ws.party = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m.t === 'join') {
      if (ws.room) return;
      const code = cleanRoom(m.room); if (!code) return send(ws, { t: 'error', msg: 'ワールドの合言葉が空です' });
      let r = rooms.get(code);
      if (!r) { r = { members: new Map(), parties: new Map() }; rooms.set(code, r); }
      if (r.members.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: `このワールドはいっぱいです(${MAX_PLAYERS}人まで)` });
      ws.room = code; ws.name = cleanName(m.name) || '冒険者';
      const peers = [...r.members.values()].map(p => ({ id: p.id, name: p.name, party: p.party }));
      r.members.set(ws.id, ws);
      send(ws, { t: 'welcome', id: ws.id, room: code, peers, parties: partyList(r), partyMax: PARTY_MAX });
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
          sendParties(r); sendStash(r, ws, true);
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
      case 'ps': {   // パーティー倉庫
        if (!ws.party) return send(ws, { t: 'error', soft: 1, msg: 'パーティーに入ると使えます' });
        const key = stashKey(ws); let st = stashes.get(key);
        if (m.op === 'sync') {   // 各自のゲームの控えで、サーバーが空のときだけ元に戻す
          if ((!st || (!st.items.length && st.ver === 0)) && Array.isArray(m.items) && m.ver > 0) {
            st = { ver: m.ver, items: m.items.filter(it => it && it.uid && Number.isInteger(it.gx) && Number.isInteger(it.gy)).slice(0, STASH_W * STASH_H).map(it => ({ item: it, w: Math.max(1, Math.min(4, it.__w || 1)), h: Math.max(1, Math.min(4, it.__h || 1)) })) };
            stashes.set(key, st); sendStash(r, ws); return;
          }
          return sendStash(r, ws, true);
        }
        if (!st) { st = { ver: 0, items: [] }; stashes.set(key, st); }
        if (m.op === 'put') {
          const it = m.item, w = Math.max(1, Math.min(4, m.w | 0)), h = Math.max(1, Math.min(4, m.h | 0));
          const fail = msg => send(ws, { t: 'ps_fail', item: it, msg });
          if (!it || !it.uid || !Number.isInteger(it.gx) || !Number.isInteger(it.gy)) return fail('アイテムが正しくありません');
          if (it.gx < 0 || it.gy < 0 || it.gx + w > STASH_W || it.gy + h > STASH_H) return fail('倉庫のマスからはみ出しています');
          it.__w = w; it.__h = h;
          const e = { item: it, w, h };
          if (st.items.some(x => x.item.uid === it.uid || overlap(x, e))) return fail('そこには置けません');
          st.items.push(e); st.ver++; sendStash(r, ws);
        } else if (m.op === 'take') {
          const k = st.items.findIndex(x => x.item.uid === m.uid);
          if (k < 0) { send(ws, { t: 'error', soft: 1, msg: 'ほかの人が先に取りました' }); return sendStash(r, ws, true); }
          const [e] = st.items.splice(k, 1); st.ver++;
          send(ws, { t: 'ps_took', item: e.item }); sendStash(r, ws);
        }
        return;
      }
    }
  });
  ws.on('close', () => {
    const r = ws.room && rooms.get(ws.room); if (!r) return;
    const hadParty = !!ws.party; leaveParty(r, ws);
    r.members.delete(ws.id);
    if (!r.members.size) { rooms.delete(ws.room); return; }
    for (const p of r.members.values()) send(p, { t: 'peer-', id: ws.id });
    if (hadParty) sendParties(r);
  });
});

setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 25000);
server.listen(PORT, () => console.log(`abyss-relay v3 listening on ${PORT} (storage: ${STORAGE})`));
