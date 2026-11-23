# Agente de control para macOS

Programa chico que corre en el Mac que comparte pantalla. Recibe desde la página
del host (Chrome, en ese mismo Mac) los eventos de mouse y teclado del equipo
remoto y los aplica en macOS. No se despliega en el VPS.

## Instalación (una sola vez)

```bash
cd agent
npm install
```

Requiere Node 20 o más nuevo. No hace falta firmar nada: el permiso de
Accesibilidad se le da a la terminal desde la que lo corrés.

## Uso

```bash
cd agent
npm start
```

1. La primera vez, macOS pide el permiso de **Accesibilidad**. Activá tu terminal
   (Terminal, iTerm…) en *Ajustes del Sistema → Privacidad y seguridad →
   Accesibilidad* y volvé a iniciar el agente.
2. El agente muestra un **token**. Pegalo en la sección «Control remoto» de la
   página del host y tocá **Conectar**. Queda guardado en el navegador y en
   `~/.puente-agent/token`, así que no cambia entre reinicios.
3. Compartí **la pantalla completa** (no una ventana). Desde el viewer, tocá
   **Pedir control** y aceptalo en el Mac, o activá «Aceptar pedidos de control
   sin preguntar» si nadie va a estar frente al Mac.

Chrome puede preguntar si la página puede acceder a «otros dispositivos o apps
de la red local»: aceptalo, es la conexión al agente en `127.0.0.1`.

Para cortar todo de inmediato: **Quitar control** en la página, o `Ctrl+C` en la
terminal del agente. Al desconectarse, el agente suelta todas las teclas y
botones que hayan quedado apretados.

## Seguridad

- Escucha solo en `127.0.0.1`: no es accesible desde la red.
- Solo acepta conexiones desde los orígenes de `PUENTE_ORIGINS` y con el token.
- Para invalidar el token, borrá `~/.puente-agent/token` y reiniciá el agente.

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
- El teclado se envía por tecla física: los atajos usan Cmd en el Mac. Si el
  viewer está en Windows, su tecla Windows es Cmd y Ctrl sigue siendo Ctrl.
- La escritura con IME (chino) y los atajos Ctrl↔Cmd llegan en la fase 2.
