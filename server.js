const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
// FIX Bug #219c: antes 2h fijas desde createdAt — una sala activa se cerraba a
// mitad de partida a las 2h aunque hubiera tráfico. Ahora medimos inactividad
// (lastActivity) y barremos salas ociosas > 30 min.
const ROOM_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min de inactividad
const HEARTBEAT_INTERVAL_MS = 30 * 1000;     // FIX Bug #219b: ping WS cada 30s
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
  ws._relay = { room: null, peerId: 0, isHost: false, handshakeDone: false, msgCount: 0, rateWindowStart: Date.now(), rateViolations: 0, isAlive: true };

  // FIX Bug #219b: al recibir pong, la conexión sigue viva → resetear el flag.
  ws.on('pong', () => { if (ws._relay) ws._relay.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    const relay = ws._relay;
    const now = Date.now();
    if (now - relay.rateWindowStart >= RATE_LIMIT_WINDOW_MS) { relay.msgCount = 0; relay.rateWindowStart = now; }
    relay.msgCount++;
    if (relay.msgCount > RATE_LIMIT_MAX_MSGS) {
      // FIX Bug #219e: antes solo respondía con un error y seguía aceptando
      // mensajes — un cliente abusivo podía inundar el relay indefinidamente.
      // Ahora contamos violaciones y cerramos la conexión al 3er exceso.
      relay.rateViolations++;
      if (relay.rateViolations >= 3) {
        ws.close(1008, 'Rate limit exceeded repeatedly');
      } else {
        ws.send(JSON.stringify({ event: 'error', message: 'Rate limit exceeded' }));
      }
      return;
    }
    if (data.length > MAX_MSG_BYTES) { ws.send(JSON.stringify({ event: 'error', message: 'Message too large' })); return; }

    if (!relay.handshakeDone) {
      try { handleHandshake(ws, JSON.parse(data.toString())); }
      catch (e) { ws.send(JSON.stringify({ event: 'error', message: 'JSON invalido' })); }
      return;
    }

    if (!isBinary) {
      try {
        const textMsg = JSON.parse(data.toString());
        // Ping: responder directamente al sender, no hacer broadcast
        if (textMsg.type === 'ping') {
          // FIX Bug #219c: los pings del juego (cada ~2s) mantienen viva la sala.
          const rPing = rooms.get(relay.room);
          if (rPing) rPing.lastActivity = Date.now();
          ws.send(JSON.stringify({ type: 'pong', t: textMsg.t }));
          return;
        }
        if (textMsg.type) {
          const room = rooms.get(relay.room);
          if (!room) return;
          room.lastActivity = Date.now(); // FIX Bug #219c: refrescar actividad de la sala
          // FIX Bug #219d: anti-spoof. player_info lleva peer_id, clase y nombre;
          // un cliente malicioso podría poner el peer_id de OTRO jugador y
          // sobrescribir su clase/nombre en el resto de peers. Forzamos el
          // peer_id real de esta conexión antes de reenviar.
          if (textMsg.type === 'player_info') { textMsg.peer_id = relay.peerId; }
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
    room.lastActivity = Date.now(); // FIX Bug #219c: refrescar actividad de la sala
    if (relay.isHost) {
      if (data.length < 4) return;
      const buf = Buffer.from(data);
      // FIX Bug #216: leer el target como SIGNED. Godot usa ids negativos como
      // "broadcast excepto N" (p.ej. -3 = todos menos el peer 3). Con readUInt32LE
      // esos negativos se leían como enteros gigantes → no coincidían con ningún
      // cliente y el paquete se descartaba (rompía partidas de 3-4 jugadores).
      const targetId = buf.readInt32LE(0);
      const payload = buf.slice(4);
      const outBuf = Buffer.alloc(4 + payload.length);
      outBuf.writeUInt32LE(1, 0); // source = host (peer 1)
      payload.copy(outBuf, 4);
      if (targetId === 0) {
        // Broadcast a todos los clientes
        for (const [, cws] of room.clients) { if (cws.readyState === 1) cws.send(outBuf); }
      } else if (targetId < 0) {
        // FIX Bug #216: "broadcast excepto N" — enviar a todos MENOS el peer
        // |targetId| (y menos el sender, que aquí es el host y no está en clients).
        const excluido = -targetId;
        for (const [pid, cws] of room.clients) {
          if (pid !== excluido && cws.readyState === 1) cws.send(outBuf);
        }
      } else {
        const cws = room.clients.get(targetId);
        if (cws && cws.readyState === 1) cws.send(outBuf);
      }
    } else {
      // Cliente → host: strip 4-byte target prefix (igual que host→client) y prepend source.
      // Sin este fix: host recibe [source][target][rpc_data], quita source,
      // Godot recibe [target][rpc_data] → todos los RPCs del cliente llegan corruptos.
      const buf        = Buffer.from(data);
      const rpcPayload = buf.length >= 4 ? buf.slice(4) : buf;
      const outBuf     = Buffer.alloc(4 + rpcPayload.length);
      outBuf.writeUInt32LE(relay.peerId, 0);
      rpcPayload.copy(outBuf, 4);
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
    rooms.set(code, { host: ws, clients: new Map(), nextId: 2, createdAt: Date.now(), lastActivity: Date.now() });
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
    room.lastActivity = Date.now(); // FIX Bug #219c: un nuevo joiner mantiene viva la sala
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
    // FIX Bug #219c: expirar por inactividad (lastActivity), no por antigüedad.
    const idle = now - (room.lastActivity || room.createdAt);
    if (idle > ROOM_IDLE_TIMEOUT_MS) {
      const msg = JSON.stringify({ event: 'error', message: 'Sala expirada por inactividad' });
      if (room.host && room.host.readyState === 1) { room.host.send(msg); room.host.close(); }
      for (const [, cws] of room.clients) { if (cws.readyState === 1) { cws.send(msg); cws.close(); } }
      rooms.delete(code);
    }
  }
}, 60_000);

// FIX Bug #219b: heartbeat WebSocket. Render (y proxies intermedios) pueden dejar
// conexiones "medio abiertas" que nunca disparan 'close'. Cada 30s marcamos todas
// las conexiones como no-vivas y enviamos ping(); el pong (más abajo) las vuelve a
// marcar vivas. Las que no respondieron desde el último tick se terminan y se
// limpia su slot de sala vía handleDisconnect.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const relay = ws._relay;
    if (!relay) continue;
    if (relay.isAlive === false) {
      handleDisconnect(ws);
      ws.terminate();
      continue;
    }
    relay.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on('close', () => clearInterval(heartbeat));

function shutdown(signal) {
  const msg = JSON.stringify({ event: 'error', message: 'Servidor reiniciando' });
  for (const client of wss.clients) { if (client.readyState === 1) { client.send(msg); client.close(); } }
  httpServer.close(() => { process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

httpServer.listen(PORT, '0.0.0.0', () => { console.log('[RELAY] Puerto ' + PORT); });
