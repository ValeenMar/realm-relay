# realm-relay

Servidor WebSocket relay para el multijugador de **Realm Brawl** (Godot 4).

Permite partidas online sin port forwarding: los jugadores se conectan a este servidor central que enruta los paquetes entre host y clientes.

---

## Protocolo

### Handshake (JSON, texto)

**Crear sala (host):**
```json
→ { "action": "create" }
← { "event": "room_created", "code": "ABCD12", "peer_id": 1 }
```

**Unirse a sala (cliente):**
```json
→ { "action": "join", "code": "ABCD12" }
← { "event": "joined", "peer_id": 2, "code": "ABCD12" }
← { "event": "peer_connected", "peer_id": 1 }   // host
← { "event": "peer_connected", "peer_id": N }   // otros clientes ya en sala
```

### Eventos del servidor

| Evento | Descripción |
|---|---|
| `peer_connected` | Un peer se unió a la sala |
| `peer_disconnected` | Un peer se desconectó |
| `host_disconnected` | El host cerró la sala |
| `error` | Error (sala no encontrada, sala llena, rate limit, etc.) |

### Mensajes custom (JSON con campo `type`)

Cualquier mensaje JSON con un campo `type` es reenviado a todos los peers de la sala. Ejemplo:

```json
{ "type": "player_info", "peer_id": 2, "clase": 1, "nombre": "Valeen" }
```

### Datos de juego (binario)

**Host → cliente(s):** `[4 bytes target_peer_id LE][payload]`
- `target_peer_id = 0` → broadcast a todos los clientes
- `target_peer_id = N` → unicast al cliente N

**Cliente → host:** `[payload]`
- El relay antepone el `peer_id` del cliente como source antes de enviarlo al host

---

## Límites

| Parámetro | Valor |
|---|---|
| Jugadores por sala | 4 (1 host + 3 clientes) |
| Expiración de sala | 2 horas |
| Tamaño máximo de mensaje | 64 KB |
| Rate limit | 60 mensajes/segundo por conexión |
| Conexiones máx. por IP | 8 |

---

## Deployment en Render

El servidor está configurado para correr en [Render](https://render.com) usando el archivo `render.yaml` de este repositorio.

1. Fork o conecta este repo en Render
2. Render detecta `render.yaml` automáticamente
3. La URL del servidor será algo como `wss://realm-relay.onrender.com`

### Correr localmente

```bash
npm install
npm start
```

El servidor escucha en el puerto `8080` por defecto (o `PORT` si está definido en el entorno).

**Health check:** `GET /health` → devuelve status, rooms activas, conexiones y uptime.

---

## Estructura del proyecto

```
server.js       ← Servidor principal
package.json    ← Dependencias (ws)
render.yaml     ← Configuración de deployment en Render
```
