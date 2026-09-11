# ROBOVISOR AR — visor robótico corporal

**Juego de realidad extendida para el celular: mirá tus manos, tus dedos y todo tu cuerpo
convertidos en hardware robótico, con la cámara frontal y la trasera, modo gafas estéreo y modo
WebXR. Corre 100 % en GitHub Pages: sin servidor, sin build, sin cuentas.**

> Entrá al sitio, tocá **▶ Iniciar con la cámara**, dale permiso a la cámara y empezá a
> calibrar tu cuerpo. Si tu dispositivo no puede, hay un **modo Demo** con un cuerpo
> sintético para que veas todo funcionando igual.

---

## 1. Qué hace (y qué NO hace)

| Sí | No |
|---|---|
| Convierte **tus partes del cuerpo** en robóticas en tiempo real (manos, dedos, brazos, torso, cara, piernas). | No altera el fondo: lo que no es cuerpo humano detectado queda tal cual lo ve la cámara. |
| Usa **cámara frontal y trasera** (cambiás en un toque; la trasera sirve para escanear a otra persona). | No sube ni transmite ninguna imagen: toda la visión por computadora ocurre en el dispositivo. |
| Funciona en **VR/AR**: WebXR inmersivo si el navegador lo soporta, y **modo gafas estéreo** (Cardboard + giroscopio) si no. | No necesita app, ni APK, ni root, ni login. |
| Juego completo: protocolo de calibración, núcleos de servo, combo, integridad, rondas y récord guardado. | No requiere teclado ni mouse; se juega con gestos (o con el puntero si no hay cámara). |

La regla del juego **es** la regla técnica: el sombreador del visor recibe una máscara
construida únicamente con geometría corporal (tubos de esqueleto + palmas + dedos + cara,
recortados por la silueta del segmentador). Fuera de esa máscara el pixel del video se
re-emite sin cambios.

## 2. Publicarlo en GitHub Pages

Opción A (cero configuración): **Settings → Pages → Build and deployment → Source:
`Deploy from a branch` → Branch: `main` / `/ (root)` → Save**. En 1-2 minutos:

```
https://<tu-usuario>.github.io/roboticviewer_AR/
```

Opción B (con la acción incluida): `.github/workflows/deploy-pages.yml` corre los tests,
verifica que todos los assets respondan y publica la raíz del repo con `actions/deploy-pages`
(activá **GitHub Pages → Source: GitHub Actions** para usarla).

El proyecto ya trae `.nojekyll` (los `_` de MediaPipe romperían Jekyll), usa **sólo rutas
relativas** (`./js/...`, `../vendor/...`) y funciona igual en la raíz del dominio que en una
subcarpeta de proyecto.

## 3. Cómo se juega

1. **Buscá tu cuerpo**: el visor necesita verte (brazos y manos al menos). El HUD dice
   `robotización NN %` — es cuánta pantalla está siendo alterada.
2. **Atrapá un núcleo de servo**: cada núcleo pertenece a una parte del cuerpo (su etiqueta
   lo dice). Hacé **pinza** (🤏 pulgar + índice) cerca de él para agarrarlo.
3. **Conectalo en SU zócalo**: con el núcleo agarrado, llevá la mano al zócalo de ESA parte y
   **abrí la palma** (🖐). Si la zona no es un cuerpo humano detectado, el visor **rechaza**
   la alteración y perdés integridad.
4. **Cambiá de cámara**: con la **trasera** apuntás a otra persona y la escaneás (mantenela en
   cuadro: la línea de escaneo sube al 100 % y desbloquea planos robóticos + un núcleo extra).
5. **Gestos rápidos** puntúan y cumplen objetivos: ✊ puño, 🖐 palma, 🤏 pinza, ☝ señalar,
   ✌ paz, 👍 pulgar.
6. Ronda de 95 s: completá todo el protocolo antes de tiempo → bonus + siguiente protocolo
   (más núcleos, más rápido). Integridad en 0 o tiempo en 0 → fin de la sesión.

**Atajos de teclado** (escritorio): `P` pausa · `C` cambiar cámara · `V` modo inmersivo ·
`D` demo · `S` ajustes · `H` ayuda · `1..6` gestos.
**Sin cámara** (o para probar en la compu): mantener presionado sobre la pantalla = pinza,
soltar = abrir la palma.

## 4. Modos de visualización

| Modo | Qué necesit | Qué vas a ver |
|---|---|---|
| **Visor 2D** (por defecto) | cualquier celular con cámara | video a pantalla completa + cuerpo robótico proyectado encima + HUD. |
| **RA inmersiva** (`immersive-ar`) | Chrome Android + ARCore | la cámara real es el fondo del sistema; tu cuerpo robótico queda anclado al piso delante tuyo y lo podés rodear. |
| **VR inmersiva** (`immersive-vr`) | gafas con WebXR (Quest, Pico) o PCVR | sala holográfica, cuerpo robótico primero-persona, selección con gatillo/mira. |
| **Modo gafas** (estéreo) | cualquier Android con giroscopio + una funda Cardboard | pantalla partida en dos ojos, el video robotizado como "pantalla flotante" y el cuerpo saliendo de ella hacia vos. |

En **escritorio sin cámara** el modo gafas usa el mouse para la mirada; en **iOS** no hay
WebXR (limitación de Safari), así que se usa visor 2D / modo gafas con giroscopio.

## 5. Pipeline

```
<video> (getUserMedia, frontal/trasera)
   │  sólo cuando hay frame nuevo (30 fps de cámara vs 60 fps de render)
   ├─► HandLandmarker (2 manos, 21 puntos) ──
   ├─► PoseLandmarker (33 puntos)  ──────────┤─► buildBody()  → partes humanas + esqueleto
   ├─► FaceLandmarker (478 + blendshapes) ───┤        │        (visibilidad y confianza reales)
   └─► ImageSegmenter (silueta selfie) ──────┘        ├─► MaskBuilder → máscara R=tubos G=silueta B=zócalos
                                                      │        └─► Compositor (GLSL): altera SÓLO adentro de la máscara
                              gestos (puño/palma/pinza/…) ─► Rules (motor de juego puro)
                              proximidad mano↔núcleozócalo ─► Play  ─────► eventos → HUD / audio / vibración
                                                      │
                                        RobotRig (three.js, primitivas) + CoreField (núcleos y zócalos)
```

* **Sin dependencias de red en tiempo de ejecución** salvo los modelos de MediaPipe
  (`.task`/`.tflite`): se descargan una vez con barra de progreso y quedan en **IndexedDB**
  (el resto —three.js, WASM, shaders, íconos— está vendorizado en el repo).
* **Degradación amable**: si un modelo falla, el juego sigue con los que haya; si la GPU
  falla, se prueba el delegate CPU; si todo falla, entra el **cuerpo sintético** (`js/sim.js`)
  y se puede jugar con el puntero.
* **Calidad adaptiva**: si el render cae por debajo de ~26 fps, se activan modo ligero
  (menos detectores, máscara más chica) y se avisa en el HUD.

## 6. Estructura

```
index.html                 pantalla única (HUD, arranque, ajustes, resultado)
css/app.css                HUD de casco: vidrio, scanlines, safe-area, táctil >= 44 px
js/config.js               TODOS los números y textos tunables (modelos, cámara, juego)
js/main.js                 arranque, permisos, degradación, atajos
js/ui.js                   HUD/pantallas (DOM puro)
js/camera.js               getUserMedia frontal/trasera, linterna, zoom, timestamp monótono
js/track/tracker.js        MediaPipe: carga con progreso, GPU→CPU, scheduler por perfiles
js/track/parts.js          landmarks → partes humanas (puro, testeable)
js/track/gestures.js       clasificación de gestos con histéresis (puro)
js/game/rules.js           motor del juego: rondas, objetivos, combo, integridad (puro)
js/game/play.js            agarre/conexión/escaneo en espacio de imagen (puro)
js/game/game.js            escena, modos, proyección, eventos, HUD, calidad adaptiva
js/robot/mask.js           máscara "sólo partes humanas" (canvas + scratch difuminado)
js/robot/compositor.js     sombreador que robotiza adentro de la máscara
js/robot/rig.js            cuerpo robótico procedural (huesos, manos de 21 articulaciones, casco)
js/robot/objects.js        núcleos de servo, zócalos, hilos guía, etiquetas
js/robot/project.js        image-space ↔ render-space (cover del video, profundidad)
js/robot/envmap.js         environment map de estudio + sala holográfica (sin assets)
js/xr/xr.js                WebXR (AR/VR), pose de giroscopio y render estéreo
js/sim.js                  cuerpo humano sintético (demo + tests)
js/audio.js                SFX de servo sintetizados con WebAudio
tests/*.test.mjs           41 pruebas: reglas, percepción, integración, enlaces
vendor/                    three.js y MediaPipe (wasm incluido) para no depender de CDN
```

## 7. Desarrollo local

```bash
node scripts/serve.mjs 8080   # servidor estático (http://localhost es contexto seguro)
node --test                   # 41 pruebas: motor de juego, percepción, integración, enlaces
node scripts/check.mjs        # verifica que TODO asset relativo responda 200 y con buen content-type
```

No hay `npm install` obligatorio: el repo ya incluye `vendor/`. `package.json` sólo aporta
los scripts.

## 8. Limitaciones conocidas

* **WebXR + cámara simultánea**: en sesiones inmersivas la cámara la posee el sistema; si el
  dispositivo no permite seguir detectando manos, el cuerpo se anima con la última pose y se
  juega con toque/gatillo (mira al núcleo y tocá para agarrar, mirá la parte humana y tocá para
  conectar).
* **iOS/Safari**: no tiene WebXR → se usa visor 2D o modo gafas (giroscopio con permiso).
* **Lentes de Realidad Aumentada tipo Cardboard**: sin distorsión barrel (se omitió a propósito
  para mantener el bundle chico y sin build); con lentes de 45 mm la imagen se ve ligeramente
  plana en los bordes.
* Si tu red bloquea `storage.googleapis.com`, podés poner un espejo en **Ajustes → Fuente de modelos**
  (debe respetar la estructura `pose_landmarker/…`, `hand_landmarker/…`, etc.).

## 9. Privacidad

No hay backend, ni analítica, ni fetch de nada que no sea el propio repositorio y los modelos.
El video nunca se sube: se procesa en el GPU/CPU del teléfono y se descarta en el siguiente frame.
Por eso el sitio funciona incluso en avión después de la primera carga (service worker + caché).

## 10. Licencias

Código de este proyecto: **MIT** (ver `LICENSE`).
Terceros en `vendor/`: three.js (**MIT**), `@mediapipe/tasks-vision` y sus `.wasm`
(**Apache-2.0**, Google LLC). Los modelos de MediaPipe se descargan del catálogo oficial de
Google bajo los términos del proyecto MediaPipe.
