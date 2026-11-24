# Audio para reuniones remotas (macOS + BlackHole)

Objetivo: entrar a una reunión (Zoom, Meet, Teams…) que corre en el Mac, desde
el viewer, como si estuvieras frente a él: escuchás a los participantes y ellos
te escuchan a vos.

```
Reunión en el Mac ──altavoz──▶ BlackHole 2ch ──▶ Puente (host) ──WebRTC──▶ tus auriculares
Tu micrófono ──WebRTC──▶ Puente (host) ──▶ BlackHole 16ch ──micrófono──▶ Reunión en el Mac
```

Se usan **dos** dispositivos virtuales para que tu voz nunca vuelva a vos (sin
eco ni bucles).

## 1. Instalar BlackHole (una sola vez)

```bash
brew install blackhole-2ch blackhole-16ch
```

Si después de instalar no aparecen, reiniciá el audio del sistema:

```bash
sudo killall coreaudiod
```

Chrome necesita permiso de micrófono para leer BlackHole: *Ajustes del Sistema →
Privacidad y seguridad → Micrófono → Google Chrome*.

## 2. Configurar la app de la reunión

En la configuración de audio de Zoom / Meet / Teams:

| Opción | Valor |
|---|---|
| Altavoz | **BlackHole 2ch** |
| Micrófono | **BlackHole 16ch** |

Así nadie frente al Mac escucha la reunión, y la app no capta el ambiente del Mac.

¿Querés escuchar **todo** el sonido del Mac, no solo la reunión? En *Configuración
de Audio MIDI* creá un *Dispositivo de salida múltiple* con «Altavoces» y
«BlackHole 2ch», y elegilo como salida del sistema. Ojo: con esa salida macOS no
deja usar las teclas de volumen.

## 3. Configurar Puente en el host

En la sección **Audio** del panel (aparece al compartir pantalla):

1. Si dice que falta permiso, tocá **Permitir acceso al audio**.
2. **Sonido que se envía:** `BlackHole 2ch`.
3. **Dónde suena la voz remota:** `BlackHole 16ch`.

Las elecciones quedan guardadas en ese navegador.

## 4. En el viewer

1. **Activar sonido** para escuchar (los navegadores exigen un clic).
2. **Activar micrófono** para hablar. El host muestra cuándo está activo.
3. Usá auriculares: la cancelación de eco ayuda, pero con parlantes la reunión
   puede escucharse a sí misma con retardo.

## Problemas comunes

- **No aparece BlackHole en Puente:** tocá «Permitir acceso al audio» y revisá el
  permiso de micrófono de Chrome en macOS.
- **Te escuchan con eco:** usá auriculares en el viewer.
- **No escuchás la reunión:** confirmá que la app de la reunión usa BlackHole 2ch
  como altavoz y que en el viewer tocaste «Activar sonido».
- **No te escuchan:** el micrófono de la reunión tiene que ser BlackHole 16ch y en
  Puente «Dónde suena la voz remota» también.
- La latencia a China suma unos 300 ms en cada sentido: alcanza para conversar,
  pero conviene no pisarse al hablar.
