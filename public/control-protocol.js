// Mensajes de control remoto que viajan por los DataChannels.
//
// Viewer → host
//   { t: 'req' }                         pide control
//   { t: 'release' }                     suelta el control
//   { t: 'm', x, y }                     mueve el mouse (x, y normalizados 0..1)
//   { t: 'd' | 'u', b, x, y, n?, k? }    botón abajo/arriba (0 izq, 1 medio, 2 der; n = cantidad de clics)
//   { t: 'w', dx, dy }                   rueda, en píxeles
//   { t: 'kd' | 'ku', c, k? }            tecla abajo/arriba (KeyboardEvent.code)
//   { t: 'reset' }                       suelta todas las teclas (incluidos los modificadores) y botones
//   { t: 'mic', on }                     avisa si el micrófono del viewer está activo
//
// k es el estado de los modificadores en el navegador del viewer en ese momento,
// como máscara de bits: 1 Ctrl, 2 Shift, 4 Alt, 8 Meta (Cmd/Windows). El agente lo
// usa para soltar cualquier modificador que haya quedado apretado por error.
//
// Host → viewer
//   { t: 'grant' } | { t: 'revoke' } | { t: 'deny', reason }

export const AGENT_URL = 'ws://127.0.0.1:47800';

const unit = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const button = (value) => value === 0 || value === 1 || value === 2;
const delta = (value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000;
const keyCode = (value) => typeof value === 'string' && /^[A-Za-z0-9]{1,24}$/.test(value);
const modifierMask = (value) => Number.isInteger(value) && value >= 0 && value <= 15;

export function modifierMaskOf(event) {
  return (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
}

function withModifiers(clean, event) {
  if (modifierMask(event.k)) clean.k = event.k;
  return clean;
}

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
      return withModifiers({ t: event.t, b: event.b, x: event.x, y: event.y, n: clicks }, event);
    }
    case 'w':
      return delta(event.dx) && delta(event.dy) ? { t: 'w', dx: event.dx, dy: event.dy } : null;
    case 'kd':
    case 'ku':
      return keyCode(event.c) ? withModifiers({ t: event.t, c: event.c }, event) : null;
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
