const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const ROOM_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 horas
const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Sin 0/O/1/I para evitar confusión

// ─── Estado global ───
const rooms = new Map(); // code -> { host, clients: Map<peer_id, ws>, nextId, createdAt }

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

// ─── HTTP server (health check) ───
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      uptime: process.uptime(),
      connections: wss ? wss.clients.size : 0
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── WebSocket server ───
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws._relay = { room: null, peerId: 0, isHost: false, handshakeDone: false };

  ws.on('message', (data, isBinary) => {
    const relay = ws._relay;

    // ─── Handshake fase (texto JSON) ───
    if (!relay.handshakeDone) {
      try {
        const msg = JSON.parse(data.toString());
        handleHandshake(ws, msg);
      } catch (e) {
        ws.send(JSON.stringify({ event: 'error', message: 'JSON inválido' }));
      }
      return;
    }

    // ─── Datos de juego (binario) ───
    if (!isBinary) return;
    const room = rooms.get(relay.room);
    if (!room) return;

    if (relay.isHost) {
      // Host envía: [4 bytes target_peer_id][payload]
      if (data.length < 4) return;
      const buf = Buffer.from(data);
      const targetId = buf.readUInt32LE(0);
      const payload = buf.slice(4);

      // Crear paquete para cliente: [4 bytes source=1][payload]
      const outBuf = Buffer.alloc(4 + payload.length);
      outBuf.writeUInt32LE(1, 0); // source = host (peer_id 1)
      payload.copy(outBuf, 4);

      if (targetId === 0) {
        // Broadcast a todos los clientes
        for (const [pid, clientWs] of room.clients) {
          if (clientWs.readyState === 1) {
            clientWs.send(outBuf);
          }
        }
      } else {
        // Unicast al cliente específico
        const clientWs = room.clients.get(targetId);
        if (clientWs && clientWs.readyState === 1) {
          clientWs.send(outBuf);
        }
      }
    } else {
      // Cliente envía: [payload] → relay agrega peer_id y manda al host
      const buf = Buffer.from(data);
      const outBuf = Buffer.alloc(4 + buf.length);
      outBuf.writeUInt32LE(relay.peerId, 0); // source = este cliente
      buf.copy(outBuf, 4);

      if (room.host && room.host.readyState === 1) {
        room.host.send(outBuf);
      }
    }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
  });

  ws.on('error', () => {
    handleDisconnect(ws);
  });
});

// ─── Handshake ───
function handleHandshake(ws, msg) {
  const relay = ws._relay;

  if (msg.action === 'create') {
    const code = generateCode();
    const room = {
      host: ws,
      clients: new Map(),
      nextId: 2,
      createdAt: Date.now()
    };
    rooms.set(code, room);

    relay.room = code;
    relay.peerId = 1;
    relay.isHost = true;
    relay.handshakeDone = true;

    ws.send(JSON.stringify({
      event: 'room_created',
      code: code,
      peer_id: 1
    }));

    console.log(`[ROOM] Sala ${code} creada por host`);

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

    relay.room = code;
    relay.peerId = peerId;
    relay.isHost = false;
    relay.handshakeDone = true;

    // Notificar al cliente su peer_id
    ws.send(JSON.stringify({
      event: 'joined',
      peer_id: peerId,
      code: code
    }));

    // Notificar al host que un peer se conectó
    if (room.host && room.host.readyState === 1) {
      room.host.send(JSON.stringify({
        event: 'peer_connected',
        peer_id: peerId
      }));
    }

    // Notificar al nuevo cliente de todos los peers existentes (host + otros clientes)
    ws.send(JSON.stringify({ event: 'peer_connected', peer_id: 1 })); // host
    for (const [existingId] of room.clients) {
      if (existingId !== peerId) {
        ws.send(JSON.stringify({ event: 'peer_connected', peer_id: existingId }));
        // Notificar a los otros clientes del nuevo peer
        const otherWs = room.clients.get(existingId);
        if (otherWs && otherWs.readyState === 1) {
          otherWs.send(JSON.stringify({ event: 'peer_connected', peer_id: peerId }));
        }
      }
    }

    console.log(`[ROOM] Peer ${peerId} se unió a sala ${code} (${room.clients.size}/${MAX_PLAYERS - 1} clientes)`);

  } else {
    ws.send(JSON.stringify({ event: 'error', message: 'Acción desconocida' }));
  }
}

// ─── Desconexión ───
function handleDisconnect(ws) {
  const relay = ws._relay;
  if (!relay || !relay.room) return;

  const room = rooms.get(relay.room);
  if (!room) return;

  if (relay.isHost) {
    // Host se fue → cerrar toda la sala
    console.log(`[ROOM] Host desconectado, cerrando sala ${relay.room}`);
    for (const [pid, clientWs] of room.clients) {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({ event: 'host_disconnected' }));
        clientWs.close();
      }
    }
    rooms.delete(relay.room);
  } else {
    // Cliente se fue → notificar al host y otros clientes
    room.clients.delete(relay.peerId);
    console.log(`[ROOM] Peer ${relay.peerId} desconectado de sala ${relay.room}`);

    if (room.host && room.host.readyState === 1) {
      room.host.send(JSON.stringify({
        event: 'peer_disconnected',
        peer_id: relay.peerId
      }));
    }

    for (const [pid, clientWs] of room.clients) {
      if (clientWs.readyState === 1) {
        clientWs.send(JSON.stringify({
          event: 'peer_disconnected',
          peer_id: relay.peerId
        }));
      }
    }

    // Si no quedan clientes, dejar la sala abierta (el host sigue)
  }

  relay.room = null;
}

// ─── Limpieza periódica ───
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TIMEOUT_MS) {
      console.log(`[CLEANUP] Sala ${code} expirada (${Math.round((now - room.createdAt) / 60000)}min)`);
      if (room.host && room.host.readyState === 1) {
        room.host.send(JSON.stringify({ event: 'error', message: 'Sala expirada' }));
        room.host.close();
      }
      for (const [, clientWs] of room.clients) {
        if (clientWs.readyState === 1) {
          clientWs.send(JSON.stringify({ event: 'error', message: 'Sala expirada' }));
          clientWs.close();
        }
      }
      rooms.delete(code);
    }
  }
}, 60000); // Cada minuto

// ─── Iniciar ───
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[RELAY] RealmBrawl Relay Server corriendo en puerto ${PORT}`);
  console.log(`[RELAY] Health check: http://0.0.0.0:${PORT}/health`);
});
