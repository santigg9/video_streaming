import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Login de un solo usuario, sin registro. Las credenciales vienen del entorno
// (AUTH_USERNAME / AUTH_PASSWORD) y la sesión es una cookie firmada con HMAC,
// así que no hace falta base de datos ni guardar estado en el servidor.

const COOKIE_NAME = 'puente_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;

const digest = (value) => createHash('sha256').update(String(value)).digest();

export function createAuth(env = process.env) {
  const username = env.AUTH_USERNAME || '';
  const password = env.AUTH_PASSWORD || '';
  const enabled = Boolean(username && password);
  // En producción, sin credenciales el sitio queda cerrado en vez de abierto.
  const misconfigured = !enabled && env.NODE_ENV === 'production';

  let secret = env.SESSION_SECRET || '';
  if (enabled && !secret) {
    secret = randomBytes(32).toString('hex');
    console.warn('SESSION_SECRET no está definido: las sesiones se cierran cada vez que se reinicia el servidor.');
  }
  if (!enabled && !misconfigured) {
    console.warn('AUTH_USERNAME / AUTH_PASSWORD no están definidos: el sitio queda abierto (solo para desarrollo).');
  }
  if (misconfigured) {
    console.error('Faltan AUTH_USERNAME y AUTH_PASSWORD: el sitio responde 503 hasta que se configuren.');
  }

  // Cambiar el usuario, la contraseña o el secreto invalida todas las sesiones.
  const key = createHmac('sha256', secret).update(`${username}\0${password}`).digest();
  const expectedUser = digest(username);
  const expectedPassword = digest(password);
  const failures = new Map();

  function sign(expires) {
    return createHmac('sha256', key).update(String(expires)).digest('base64url');
  }

  function readCookie(request) {
    for (const part of (request.headers.cookie || '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0 && part.slice(0, index).trim() === COOKIE_NAME) return part.slice(index + 1).trim();
    }
    return '';
  }

  function isAuthenticated(request) {
    if (!enabled) return !misconfigured;
    const [expires, signature] = readCookie(request).split('.');
    if (!expires || !signature || !/^\d+$/.test(expires)) return false;
    if (Number(expires) < Date.now() / 1000) return false;
    const expected = Buffer.from(sign(expires));
    const received = Buffer.from(signature);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  function checkCredentials(user, pass) {
    // Se comparan los hashes para que ambos lados tengan el mismo largo.
    const userOk = timingSafeEqual(digest(user), expectedUser);
    const passOk = timingSafeEqual(digest(pass), expectedPassword);
    return enabled && userOk && passOk;
  }

  function isSecure(request) {
    return request.headers['x-forwarded-proto'] === 'https' || Boolean(request.socket.encrypted);
  }

  function sessionCookie(request) {
    const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const secure = isSecure(request) ? '; Secure' : '';
    return `${COOKIE_NAME}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
  }

  function clearCookie(request) {
    const secure = isSecure(request) ? '; Secure' : '';
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }

  // nginx agrega la IP real al final de X-Forwarded-For; las anteriores las
  // puede inventar el cliente, así que se usa la última.
  function clientIp(request) {
    const forwarded = (request.headers['x-forwarded-for'] || '').split(',').map((ip) => ip.trim()).filter(Boolean);
    return forwarded.at(-1) || request.socket.remoteAddress || 'desconocida';
  }

  function isRateLimited(request) {
    const now = Date.now();
    for (const [ip, entry] of failures) {
      if (now - entry.first > FAILURE_WINDOW_MS) failures.delete(ip);
    }
    return (failures.get(clientIp(request))?.count || 0) >= MAX_FAILURES;
  }

  function recordFailure(request) {
    const ip = clientIp(request);
    const entry = failures.get(ip) || { count: 0, first: Date.now() };
    entry.count++;
    failures.set(ip, entry);
    console.warn(`Intento de login fallido desde ${ip} (${entry.count}/${MAX_FAILURES})`);
  }

  function recordSuccess(request) {
    failures.delete(clientIp(request));
  }

  return {
    enabled,
    misconfigured,
    isAuthenticated,
    checkCredentials,
    sessionCookie,
    clearCookie,
    isRateLimited,
    recordFailure,
    recordSuccess,
  };
}

// Solo rutas internas: evita que ?next= redirija a otro sitio.
export function safeNext(value) {
  if (typeof value !== 'string' || value.length > 200) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return '/';
  return value;
}
