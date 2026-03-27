const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOM_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas
const MAX_PLAYERS = 4;
const MAX_MSG_BYTES = 64 * 1024; // 64 KB — protección contra mensajes gigantes
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin 0/O/1/I para evitar confusión

// ── Rate limiting ────────────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW_MS = 1000;  // ventana de 1 segundo
const RATE_LIMIT_MAX_MSGS  = 60;    // máx 60 mensajes/segundo por conexión
const MAX_CONNECTIONS_PER_IP = 8;   // máx 8 conexiones simultáneas por IP

// ── Estado global ─────────────────────────────────────────────────────────────
const rooms = new Map();         // code → { host, clients: Map<peer_id, ws>, nextId, createdAt }
const ipConnections = new Map(); // ip → cantidad de conexiones actuales

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

// ── HTTP server (health check) ─────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:      'ok',
      rooms:       rooms.size,
      connections: wss ? wss.clients.size : 0,
      uptime:      Math.floor(process.uptime()),
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = getIp(req);

  // Límite de conexiones por IP
  const ipCount = (ipConnections.get(ip) || 0) + 1;
  if (ipCount > MAX_CONNECTIONS_PER_IP) {
    ws.close(1008, 'Too many connections from your IP');
    return;
  }
  ipConnections.set(ip, ipCount);

  ws._relay = {
    room:            null,
    peerId:          0,
    isHost:          false,
    handshakeDone:   false,
    // rate limiting
    msgCount:        0,
    rateWindowStart: Date.now(),
  };

  ws.on('message', (data, isBinary) => {
    const relay = ws._relay;

    // Rate limiting por conexión
    const now = Date.now();
    if (now - relay.rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
      relay.msgCount        = 0;
      relay.rateWindowStart = now;
    }
    relay.msgCount++;
    if (relay.msgCount > RATE_LIMIT_MAX_MSGS) {
      ws.send(JSON.stringify({ event: 'error', message: 'Rate limit exceeded' }));
      return;
    }

    // Límite de tamaño de mensaje
    if (data.length > MAX_MSG_BYTES) {
      ws.send(JSON.stringify({ event: 'error', message: 'Message too large' }));
      return;
    }

    // ── Handshake ──────────────────────────────────────────────────────────
    if (!relay.handshakeDone) {
      try {
        const msg = JSON.parse(data.toString());
        handleHandshake(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ event: 'error', message: 'JSON inválido' }));
      }
      return;
    }

    // ── Mensajes de texto custom (player_info, etc.) ────────────────────────
    if (!isBinary) {
      try {
        const textMsg = JSON.parse(data.toString());
        if (textMsg.type) {
          const room = rooms.get(relay.room);
          if (!room) return;
          const fwd = JSON.stringify(textMsg);
          if (relay.isHost) {
            // Host → todos los clientes
            for (const [, clientWs] of room.clients) {
              if (clientWs.readyState === 1) clientWs.send(fwd);
            }
          } else {
            // Cliente → host + resto de clientes
            if (room.host && room.host.readyState === 1) room.host.send(fwd);
            for (const [pid, clientWs] of room.clients) {
              if (pid !== relay.peerId && clientWs.readyState === 1) clientWs.send(fwd);
            }
          }
        }
      } catch (e) { /* JSON malformado — ignorar */ }
      return;
    }

    // ── Datos de juego (binario) ────────────────────────────────────────────
    const room = rooms.get(relay.room);
    if (!room) return;

    if (relay.isHost) {
      // Host envía: [4 bytes target_peer_id][payload]
      if (data.length < 4) return;
      const buf      = Buffer.from(data);
      const targetId = buf.readUInt32LE(0);
      const payload  = buf.slice(4);

      // Paquete saliente: [4 bytes source=1][payload]
      const outBuf = Buffer.alloc(4 + payload.length);
      outBuf.writeUInt32LE(1, 0); // source = host (peer_id 1)
      payload.copy(outBuf, 4);

      if (targetId === 0) {
        // Broadcast a todos los clientes
        for (const [, clientWs] of room.clients) {
          if (clientWs.readyState === 1) clientWs.send(outBuf);
        }
      } else {
        // Unicast a un cliente específico
        const clientWs = room.clients.get(targetId);
        if (clientWs && clientWs.readyState === 1) clientWs.send(outBuf);
      }
    } else {
      // Cliente → host: prepend peer_id como source
      const buf    = Buffer.from(data);
      const outBuf = Buffer.alloc(4 + buf.length);
      outBuf.writeUInt32LE(relay.peerId, 0);
      buf.copy(outBuf, 4);
      if (room.host && room.host.readyState === 1) room.host.send(outBuf);
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
    const count = ipConnections.get(ip) || 1;
    if (count <= 1) ipConnections.delete(ip);
    else ipConnections.set(ip, count - 1);
  });

  ws.on('error', (err) => {
    console.error('[WS] Error en conexión:', err.message);
    handleDisconnect(ws);
  });
});

// ── Handshake ──────────────────────────────────────────────────────────────────
function handleHandshake(ws, msg) {
  const relay = ws._relay;

  if (msg.action === 'create') {
    const code = generateCode();
    rooms.set(code, { host: ws, clients: new Map(), nextId: 2, createdAt: Date.now() });
    relay.room          = code;
    relay.peerId        = 1;
    relay.isHost        = true;
    relay.handshakeDone = true;
    ws.send(JSON.stringify({ event: 'room_created', code, peer_id: 1 }));
    console.log(`[ROOM] Sala ${code} creada`);

  } else if (msg.action === 'join') {
    const code = (msg.code || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      ws.send(JSON.stringify({ event: 'error', message: 'Sala no encontrada' }));
      return;
    }
    if (room.clients.size >= MAX_PLAYERS - 1) {
      ws.send(JSON.stringify({ event: 'error', message: 'Sala llena' }));
      return;
    }

    const peerId = room.nextId++;
    room.clients.set(peerId, ws);
    relay.room          = code;
    relay.peerId        = peerId;
    relay.isHost        = false;
    relay.handshakeDone = true;

    ws.send(JSON.stringify({ event: 'joined', peer_id: peerId, code }));

    if (room.host && room.host.readyState === 1) {
      room.host.send(JSON.stringify({ event: 'peer_connected', peer_id: peerId }));
    }

    // Informar al nuevo peer de todos los ya conectados
    ws.send(JSON.stringify({ event: 'peer_connected', peer_id: 1 })); // host
    for (const [existingId] of room.clients) {
      if (existingId === peerId) continue;
      ws.send(JSON.stringify({ event: 'peer_connected', peer_id: existingId }));
      // Notificar a los ya conectados del nuevo
      const otherWs = room.clients.get(existingId);
      if (otherWs && otherWs.readyState === 1) {
        otherWs.send(JSON.stringify({ event: 'peer_connected', peer_id: peerId }));
      }
    }
    console.log(`[ROOM] Peer ${peerId} unido a ${code} (${room.clients.size}/${MAX_PLAYERS - 1} clientes)`);

  } else {
    ws.send(JSON.stringify({ event: 'error', message: 'Acción desconocida' }));
  }
}

// ── Desconexión ────────────────────────────────────────────────────────────────
function handleDisconnect(ws) {
  const relay = ws._relay;
  if (!relay || !relay.room) return;
  const room = rooms.get(relay.room);
  if (!room) return;

  if (relay.isHost) {
    console.log(`[ROOM] Host desconectado — cerrando sala ${relay.room}`);
    const notif = JSON.stringify({ event: 'host_disconnected' });
    for (const [, clientWs] of room.clients) {
      if (clientWs.readyState === 1) { clientWs.send(notif); clientWs.close(); }
    }
    rooms.delete(relay.room);
  } else {
    room.clients.delete(relay.peerId);
    console.log(`[ROOM] Peer ${relay.peerId} desconectado de sala ${relay.room}`);
    const notif = JSON.stringify({ event: 'peer_disconnected', peer_id: relay.peerId });
    if (room.host && room.host.readyState === 1) room.host.send(notif);
    for (const [, clientWs] of room.clients) {
      if (clientWs.readyState === 1) clientWs.send(notif);
    }
  }
  relay.room = null;
}

// ── Limpieza periódica ─────────────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TIMEOUT_MS) {
      const ageMin = Math.round((now - room.createdAt) / 60000);
      console.log(`[CLEANUP] Sala ${code} expirada (${ageMin} min)`);
      const expiredMsg = JSON.stringify({ event: 'error', message: 'Sala expirada' });
      if (room.host && room.host.readyState === 1) { room.host.send(expiredMsg); room.host.close(); }
      for (const [, clientWs] of room.clients) {
        if (clientWs.readyState === 1) { clientWs.send(expiredMsg); clientWs.close(); }
      }
      rooms.delete(code);
    }
  }
}, 60_000);

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[RELAY] ${signal} recibido — cerrando servidor...`);
  const shutdownMsg = JSON.stringify({ event: 'error', message: 'Servidor reiniciando' });
  for (const client of wss.clients) {
    if (client.readyState === 1) { client.send(shutdownMsg); client.close(); }
  }
  httpServer.close(() => {
    console.log('[RELAY] Servidor cerrado limpiamente.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Inicio ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[RELAY] RealmBrawl Relay Server corriendo en puerto ${PORT}`);
  console.log(`[RELAY] Health: http://0.0.0.0:${PORT}/health`);
});
