const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOM_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas
const MAX_PLAYERS = 4;
const MAX_MSG_BYTES = 64 * 1024; // 64 KB
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MSGS  = 60;
const MAX_CONNECTIONS_PER_IP = 8;

const rooms = new Map();
const ipConnections = new Map();

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function getIp(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size, connections: wss ? wss.clients.size : 0, uptime: Math.floor(process.uptime()) }));
  } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = getIp(req);
  const ipCount = (ipConnections.get(ip) || 0) + 1;
  if (ipCount > MAX_CONNECTIONS_PER_IP) { ws.close(1008, 'Too many connections from your IP'); return; }
  ipConnections.set(ip, ipCount);
  ws._relay = { room: null, peerId: 0, isHost: false, handshakeDone: false, msgCount: 0, rateWindowStart: Date.now() };

  ws.on('message', (data, isBinary) => {
    const relay = ws._relay;
    const now = Date.now();
    if (now - relay.rateWindowStart >= RATE_LIMIT_WINDOW_MS) { relay.msgCount = 0; relay.rateWindowStart = now; }
    relay.msgCount++;
    if (relay.msgCount > RATE_LIMIT_MAX_MSGS) { ws.send(JSON.stringify({ event: 'error', message: 'Rate limit exceeded' })); return; }
    if (data.length > MAX_MSG_BYTES) { ws.send(JSON.stringify({ event: 'error', message: 'Message too large' })); return; }

    if (!relay.handshakeDone) {
      try { handleHandshake(ws, JSON.parse(data.toString())); }
      catch (e) { ws.send(JSON.stringify({ event: 'error', message: 'JSON invalido' })); }
      return;
    }

    if (!isBinary) {
      try {
        const textMsg = JSON.parse(data.toString());
        // Ping: responder al sender, no broadcast
        if (textMsg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong', t: textMsg.t })); return; }
        if (textMsg.type) {
          const room = rooms.get(relay.room);
          if (!room) return;
          const fwd = JSON.stringify(textMsg);
          if (relay.isHost) {
            for (const [, cws] of room.clients) { if (cws.readyState === 1) cws.send(fwd); }
          } else {
            if (room.host && room.host.readyState === 1) room.host.send(fwd);
            for (const [pid, cws] of room.clients) { if (pid !== relay.peerId && cws.readyState === 1) cws.send(fwd); }
          }
        }
      } catch (e) {}
      return;
    }

    const room = rooms.get(relay.room);
    if (!room) return;
    if (relay.isHost) {
      if (data.length < 4) return;
      const buf = Buffer.from(data);
      const targetId = buf.readUInt32LE(0);
      const payload = buf.slice(4);
      const outBuf = Buffer.alloc(4 + payload.length);
      outBuf.writeUInt32LE(1, 0);
      payload.copy(outBuf, 4);
      if (targetId === 0) {
        for (const [, cws] of room.clients) { if (cws.readyState === 1) cws.send(outBuf); }
      } else {
        const cws = room.clients.get(targetId);
        if (cws && cws.readyState === 1) cws.send(outBuf);
      }
    } else {
      const buf = Buffer.from(data);
      const outBuf = Buffer.alloc(4 + buf.length);
      outBuf.writeUInt32LE(relay.peerId, 0);
      buf.copy(outBuf, 4);
      if (room.host && room.host.readyState === 1) room.host.send(outBuf);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
    const count = ipConnections.get(ip) || 1;
    if (count <= 1) ipConnections.delete(ip); else ipConnections.set(ip, count - 1);
  });
  ws.on('error', (err) => { console.error('[WS] Error:', err.message); handleDisconnect(ws); });
});

function handleHandshake(ws, msg) {
  const relay = ws._relay;
  if (msg.action === 'create') {
    const code = generateCode();
    rooms.set(code, { host: ws, clients: new Map(), nextId: 2, createdAt: Date.now() });
    relay.room = code; relay.peerId = 1; relay.isHost = true; relay.handshakeDone = true;
    ws.send(JSON.stringify({ event: 'room_created', code, peer_id: 1 }));
    console.log('[ROOM] Sala ' + code + ' creada');
  } else if (msg.action === 'join') {
    const code = (msg.code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { ws.send(JSON.stringify({ event: 'error', message: 'Sala no encontrada' })); return; }
    if (room.clients.size >= MAX_PLAYERS - 1) { ws.send(JSON.stringify({ event: 'error', message: 'Sala llena' })); return; }
    const peerId = room.nextId++;
    room.clients.set(peerId, ws);
    relay.room = code; relay.peerId = peerId; relay.isHost = false; relay.handshakeDone = true;
    ws.send(JSON.stringify({ event: 'joined', peer_id: peerId, code }));
    if (room.host && room.host.readyState === 1) room.host.send(JSON.stringify({ event: 'peer_connected', peer_id: peerId }));
    ws.send(JSON.stringify({ event: 'peer_connected', peer_id: 1 }));
    for (const [existingId] of room.clients) {
      if (existingId === peerId) continue;
      ws.send(JSON.stringify({ event: 'peer_connected', peer_id: existingId }));
      const otherWs = room.clients.get(existingId);
      if (otherWs && otherWs.readyState === 1) otherWs.send(JSON.stringify({ event: 'peer_connected', peer_id: peerId }));
    }
    console.log('[ROOM] Peer ' + peerId + ' unido a ' + code);
  } else {
    ws.send(JSON.stringify({ event: 'error', message: 'Accion desconocida' }));
  }
}

function handleDisconnect(ws) {
  const relay = ws._relay;
  if (!relay || !relay.room) return;
  const room = rooms.get(relay.room);
  if (!room) return;
  if (relay.isHost) {
    const notif = JSON.stringify({ event: 'host_disconnected' });
    for (const [, cws] of room.clients) { if (cws.readyState === 1) { cws.send(notif); cws.close(); } }
    rooms.delete(relay.room);
  } else {
    room.clients.delete(relay.peerId);
    const notif = JSON.stringify({ event: 'peer_disconnected', peer_id: relay.peerId });
    if (room.host && room.host.readyState === 1) room.host.send(notif);
    for (const [, cws] of room.clients) { if (cws.readyState === 1) cws.send(notif); }
  }
  relay.room = null;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TIMEOUT_MS) {
      const msg = JSON.stringify({ event: 'error', message: 'Sala expirada' });
      if (room.host && room.host.readyState === 1) { room.host.send(msg); room.host.close(); }
      for (const [, cws] of room.clients) { if (cws.readyState === 1) { cws.send(msg); cws.close(); } }
      rooms.delete(code);
    }
  }
}, 60_000);

function shutdown(signal) {
  const msg = JSON.stringify({ event: 'error', message: 'Servidor reiniciando' });
  for (const client of wss.clients) { if (client.readyState === 1) { client.send(msg); client.close(); } }
  httpServer.close(() => { process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

httpServer.listen(PORT, '0.0.0.0', () => { console.log('[RELAY] Puerto ' + PORT); });
