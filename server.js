import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const port = Number(process.env.PORT || 4173);
const publicDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const rooms = new Map();

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function iceServers() {
  const servers = [];
  const stunUrls = (process.env.STUN_URLS || 'stun:stun.cloudflare.com:3478')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  if (stunUrls.length) servers.push({ urls: stunUrls });

  const turnUrls = (process.env.TURN_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  if (turnUrls.length) {
    servers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }

  return servers;
}

function send(socket, message) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function roomFor(id) {
  if (!rooms.has(id)) rooms.set(id, { host: null, viewer: null });
  return rooms.get(id);
}

function leaveRoom(socket) {
  const { roomId, role } = socket;
  const room = rooms.get(roomId);
  if (!room || room[role] !== socket) return;

  room[role] = null;
  const peerRole = role === 'host' ? 'viewer' : 'host';
  send(room[peerRole], { type: 'peer-left', role });
  if (!room.host && !room.viewer) rooms.delete(roomId);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), display-capture=(self)',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };

  if (url.pathname === '/healthz') {
    response.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/config') {
    response.writeHead(200, {
      ...headers,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({ iceServers: iceServers() }));
    return;
  }

  const isViewer = /^\/watch\/[A-Za-z0-9_-]{8,64}\/?$/.test(url.pathname);
  const pathname = isViewer ? '/watch.html' : url.pathname === '/' ? '/index.html' : url.pathname;
  const allowedFiles = new Set(['/index.html', '/watch.html', '/styles.css', '/common.js', '/host.js', '/viewer.js', '/favicon.svg']);

  if (!allowedFiles.has(pathname) || !['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(404, headers);
    response.end('No encontrado');
    return;
  }

  try {
    const file = await readFile(path.join(publicDirectory, pathname));
    response.writeHead(200, {
      ...headers,
      'Content-Type': contentTypes[path.extname(pathname)],
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : file);
  } catch {
    response.writeHead(404, headers);
    response.end('No encontrado');
  }
});

const webSockets = new WebSocketServer({ server, maxPayload: 64 * 1024 });

webSockets.on('connection', (socket) => {
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      send(socket, { type: 'error', message: 'Mensaje inválido.' });
      return;
    }

    if (message.type === 'join') {
      if (!/^[A-Za-z0-9_-]{8,64}$/.test(message.room) || !['host', 'viewer'].includes(message.role)) {
        send(socket, { type: 'error', message: 'Sala inválida.' });
        return;
      }

      leaveRoom(socket);
      const room = roomFor(message.room);
      const previous = room[message.role];
      if (previous && previous !== socket) previous.close(1000, 'Sesión reemplazada');
      room[message.role] = socket;
      socket.roomId = message.room;
      socket.role = message.role;

      const peerRole = message.role === 'host' ? 'viewer' : 'host';
      send(socket, { type: 'joined', role: message.role, peerPresent: Boolean(room[peerRole]) });
      send(room[peerRole], { type: 'peer-joined', role: message.role });
      return;
    }

    const room = rooms.get(socket.roomId);
    if (!room || room[socket.role] !== socket) {
      send(socket, { type: 'error', message: 'Primero debés unirte a una sala.' });
      return;
    }

    if (!['description', 'candidate', 'connection-settings', 'stream-stopped'].includes(message.type)) return;
    const peerRole = socket.role === 'host' ? 'viewer' : 'host';
    send(room[peerRole], message);
  });

  socket.on('close', () => leaveRoom(socket));
  socket.on('error', () => leaveRoom(socket));
});

const heartbeat = setInterval(() => {
  for (const socket of webSockets.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30000);

webSockets.on('close', () => clearInterval(heartbeat));
server.listen(port, '0.0.0.0', () => {
  console.log(`Puente disponible en http://localhost:${port}`);
});
