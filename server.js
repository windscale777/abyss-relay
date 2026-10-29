/* 深淵の刻印 — マルチプレイ用の中継サーバー(abyss-relay) v2
 *   ・ワールド(合言葉)ごとに最大 MAX_PLAYERS 人。町では全員が見える
 *   ・ワールドの中でパーティー(最大 PARTY_MAX 人)を組むと、エリアを一緒に攻略できる。パーティーのリーダーのゲームが敵を動かす
 *   ・パーティー倉庫: パーティー名ごとにアイテムを預けられる(サーバーの記憶+各自のゲームにも控え)
 *   ・チャット: ワールド全体 / パーティーだけ
 *   ゲームの計算はしません。受け取ったメッセージを渡すだけです。 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 32);
const PARTY_MAX = Number(process.env.PARTY_MAX || 4);
const STASH_W = 12, STASH_H = 8;
const MAX_MSG = 512 * 1024;
const rooms = new Map();     // ワールド名 → { members: Map(id → ws), parties: Map(パーティー名 → { name, members: [id] }) }
const stashes = new Map();   // ワールド名/パーティー名 → { ver, items: [{ item, w, h }] }
let nextId = 1;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  let players = 0; for (const r of rooms.values()) players += r.members.size;
  res.end(JSON.stringify({ ok: true, name: 'abyss-relay', version: 2, worlds: rooms.size, players, max: MAX_PLAYERS, partyMax: PARTY_MAX }));
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
server.listen(PORT, () => console.log(`abyss-relay v2 listening on ${PORT}`));
