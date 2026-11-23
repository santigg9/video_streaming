# Agente de control (macOS y Windows)

Programa chico que corre en la computadora que comparte pantalla. Recibe desde
la página del host (Chrome o Edge, en esa misma computadora) los eventos de
mouse y teclado del equipo remoto y los aplica en el sistema. No se despliega en
el VPS.

## Instalación (una sola vez)

```bash
cd agent
npm install
```

Requiere Node 20 o más nuevo. No hace falta firmar nada.

## Uso

```bash
cd agent
npm start
```

1. **Solo en macOS:** la primera vez, el sistema pide el permiso de
   **Accesibilidad**. Activá tu terminal (Terminal, iTerm…) en *Ajustes del
   Sistema → Privacidad y seguridad → Accesibilidad* y volvé a iniciar el
   agente. En Windows no hace falta ningún permiso.
2. El agente muestra un **token**. Pegalo en la sección «Control remoto» de la
   página del host y tocá **Conectar**. Queda guardado en el navegador y en
   `~/.puente-agent/token` (en Windows, `%USERPROFILE%\.puente-agent\token`), así
   que no cambia entre reinicios.
3. Compartí **la pantalla completa** (no una ventana). Desde el viewer, tocá
   **Pedir control** y aceptalo en la computadora que comparte, o activá «Aceptar
   pedidos de control sin preguntar» si nadie va a estar frente a ella.

Chrome puede preguntar si la página puede acceder a «otros dispositivos o apps
de la red local»: aceptalo, es la conexión al agente en `127.0.0.1`.

Para cortar todo de inmediato: **Quitar control** en la página, o `Ctrl+C` en la
terminal del agente. Al desconectarse, el agente suelta todas las teclas y
botones que hayan quedado apretados.

## Seguridad

- Escucha solo en `127.0.0.1`: no es accesible desde la red.
- Solo acepta conexiones desde los orígenes de `PUENTE_ORIGINS` y con el token.
- Para invalidar el token, borrá el archivo del token y reiniciá el agente.

## Variables de entorno

| Variable | Por defecto | Para qué |
|---|---|---|
| `PUENTE_ORIGINS` | `https://video.agilequest.dev,http://localhost:4173,http://127.0.0.1:4173` | Páginas que pueden conectarse |
| `PUENTE_AGENT_PORT` | `47800` | Puerto local (la página usa 47800) |
| `PUENTE_SCROLL_SCALE` | `1` | Multiplica la velocidad del scroll |
| `PUENTE_AGENT_TOKEN` | (archivo) | Fija el token a mano |
| `PUENTE_DRY_RUN` | — | Con `1`, solo muestra los eventos en la terminal, sin mover nada |

## Limitaciones de esta versión

- Controla la **pantalla principal**. Si compartís otro monitor, las coordenadas
  no coinciden.
- El teclado se envía por tecla física. Cmd (Mac) y la tecla Windows son la
  misma tecla: si el viewer está en un Mac y el host en Windows, para copiar hay
  que usar Ctrl+C, no Cmd+C (y al revés).
- **Windows:** no se pueden controlar las ventanas abiertas como administrador
  (salvo que el agente también corra como administrador), ni el aviso de UAC, la
  pantalla de bloqueo o Ctrl+Alt+Supr.
- La escritura con IME (chino) y el mapeo Ctrl↔Cmd llegan en la fase 2.
