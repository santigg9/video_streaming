// Mensajes de control remoto que viajan por los DataChannels.
//
// Viewer → host
//   { t: 'req' }                         pide control
//   { t: 'release' }                     suelta el control
//   { t: 'm', x, y }                     mueve el mouse (x, y normalizados 0..1)
//   { t: 'd' | 'u', b, x, y, n? }        botón abajo/arriba (0 izq, 1 medio, 2 der; n = cantidad de clics)
//   { t: 'w', dx, dy }                   rueda, en píxeles
//   { t: 'kd' | 'ku', c }                tecla abajo/arriba (KeyboardEvent.code)
//   { t: 'reset' }                       suelta todas las teclas y botones
//
// Host → viewer
//   { t: 'grant' } | { t: 'revoke' } | { t: 'deny', reason }

export const AGENT_URL = 'ws://127.0.0.1:47800';

const unit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const button = (value) => value === 0 || value === 1 || value === 2;
const delta = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000;
const keyCode = (value) => typeof value === 'string' && /^[A-Za-z0-9]{1,24}$/.test(value);

// Devuelve una copia limpia del evento de entrada, o null si no es válido.
// Así al agente solo llegan los campos esperados.
export function sanitizeInputEvent(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.t) {
    case 'm':
      return unit(event.x) && unit(event.y) ? { t: 'm', x: event.x, y: event.y } : null;
    case 'd':
    case 'u': {
      if (!button(event.b) || !unit(event.x) || !unit(event.y)) return null;
      const clicks = Number.isInteger(event.n) && event.n > 0 && event.n < 10 ? event.n : 1;
      return { t: event.t, b: event.b, x: event.x, y: event.y, n: clicks };
    }
    case 'w':
      return delta(event.dx) && delta(event.dy) ? { t: 'w', dx: event.dx, dy: event.dy } : null;
    case 'kd':
    case 'ku':
      return keyCode(event.c) ? { t: event.t, c: event.c } : null;
    case 'reset':
      return { t: 'reset' };
    default:
      return null;
  }
}

export function parseMessage(data) {
  if (typeof data !== 'string' || data.length > 1024) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}
