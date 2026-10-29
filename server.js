/* 深淵の刻印 — マルチプレイ用の中継サーバー
 *   合言葉(部屋の名前)ごとに最大 MAX_PLAYERS 人。ゲームの計算はしません(部屋を作った人=ホストのゲームが敵を動かします)。
 *   受け取ったメッセージを、同じ部屋のほかの人(または指定した1人)にそのまま渡すだけです。 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 10000;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 4);
const MAX_MSG = 512 * 1024;          // 1通の最大サイズ
const rooms = new Map();             // 合言葉 → { members: Map(id → ws), host: id }
let nextId = 1;

const server = http.createServer((req, res) => {
  // 起きているか確かめる用(ゲームは接続前にここを開いてサーバーを起こします)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  let players = 0; for (const r of rooms.values()) players += r.members.size;
  res.end(JSON.stringify({ ok: true, name: 'abyss-relay', rooms: rooms.size, players, max: MAX_PLAYERS }));
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MSG });
const send = (ws, o) => { if (ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)); };
const cleanRoom = s => String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

wss.on('connection', ws => {
  ws.id = nextId++; ws.alive = true; ws.room = null; ws.name = '';
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (buf, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m.t === 'join') {
      if (ws.room) return;
      const code = cleanRoom(m.room); if (!code) return send(ws, { t: 'error', msg: '合言葉が空です' });
      let r = rooms.get(code);
      if (m.create && r) return send(ws, { t: 'error', msg: 'その合言葉の部屋はもうあります。別の合言葉にしてください' });
      if (!m.create && !r) return send(ws, { t: 'error', msg: 'その合言葉の部屋が見つかりません' });
      if (!r) { r = { members: new Map(), host: ws.id }; rooms.set(code, r); }
      if (r.members.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: `部屋がいっぱいです(${MAX_PLAYERS}人まで)` });
      ws.room = code; ws.name = String(m.name || '冒険者').slice(0, 24);
      const peers = [...r.members.values()].map(p => ({ id: p.id, name: p.name }));
      r.members.set(ws.id, ws);
      send(ws, { t: 'welcome', id: ws.id, room: code, host: r.host, peers });
      for (const p of r.members.values()) if (p !== ws) send(p, { t: 'peer+', id: ws.id, name: ws.name });
      return;
    }
    if (m.t === 'r' && ws.room) {   // 中継
      const r = rooms.get(ws.room); if (!r) return;
      const out = JSON.stringify({ t: 'r', from: ws.id, d: m.d });
      if (m.to) { const p = r.members.get(m.to); if (p) send(p, out); }
      else for (const p of r.members.values()) if (p !== ws) send(p, out);
    }
  });
  ws.on('close', () => {
    const r = ws.room && rooms.get(ws.room); if (!r) return;
    r.members.delete(ws.id);
    if (!r.members.size) { rooms.delete(ws.room); return; }
    if (r.host === ws.id) r.host = r.members.keys().next().value;   // ホストが抜けたら次の人がホスト
    for (const p of r.members.values()) send(p, { t: 'peer-', id: ws.id, host: r.host });
  });
});

// 切れた接続を片づける
setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); } }, 25000);

server.listen(PORT, () => console.log(`abyss-relay listening on ${PORT}`));
