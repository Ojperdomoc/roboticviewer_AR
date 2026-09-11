/**
 * ROBOVISOR AR — configuración central.
 *
 * Todo el proyecto es estático (sin build, sin backend): se sirve tal cual desde
 * GitHub Pages. Las librerías están vendorizadas en /vendor y las rutas se
 * resuelven de forma RELATIVA para que el juego funcione tanto en la raíz como
 * en una subcarpeta tipo https://usuario.github.io/roboticviewer_AR/ .
 */

/** Ruta base derivada de este módulo (funciona en cualquier subcarpeta). */
const HERE = new URL('./', import.meta.url).href;

/** Modelos de MediaPipe (se descargan la primera vez y se cachean en localStorage). */
const GCS = 'https://storage.googleapis.com/mediapipe-models/';

export const CONFIG = {
  paths: {
    three: HERE + '../vendor/three/three.module.js',
    mediapipe: HERE + '../vendor/mediapipe/vision_bundle.mjs',
    /** FilesetResolver arma `${wasm}/vision_wasm[_nosimd]_internal.{js,wasm}` */
    mediapipeWasm: HERE + '../vendor/mediapipe/wasm',
  },

  vision: {
    /**
     * Rutas relativas del catálogo oficial de MediaPipe. `modelBase` en Ajustes permite
     * reemplazar el prefijo completo (por si tu red bloquea storage.googleapis.com).
     */
    modelRel: {
      pose: 'pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
      hands: 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
      face: 'face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      selfie: 'image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
    },
    /** Fuentes completas candidates por detector (se prueban en orden). */
    models: {
      pose: [
        GCS + 'pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
        GCS + 'pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      ],
      hands: [GCS + 'hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'],
      face: [GCS + 'face_landmarker/face_landmarker/float16/1/face_landmarker.task'],
      selfie: [GCS + 'image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite'],
    },
    /** Opciones de calidad/velocidad para el celular. */
    profiles: {
      bajo: { pose: true, hands: true, face: false, selfie: false, everyN: 2 },
      medio: { pose: true, hands: true, face: true, selfie: true, everyN: 1 },
      alto: { pose: true, hands: true, face: true, selfie: true, everyN: 1, hiRes: true },
    },
    numHands: 2,
    minConfidence: 0.5,
  },

  camera: {
    facing: {
      front: { facingMode: { ideal: 'user' } },
      rear: { facingMode: { ideal: 'environment' } },
    },
    resolution: { width: { ideal: 1280 }, height: { ideal: 720 } },
    hiRes: { width: { ideal: 1920 }, height: { ideal: 1080 } },
  },

  /**
   * "Robotización": el efecto SÓLO se aplica dentro de la máscara construida con
   * las partes del cuerpo humano detectadas. `dilation` ensancha la máscara en px
   * (canvas de máscara a 480 px de ancho) para cubrir el borde de la piel.
   */
  robotize: {
    maskWidth: 480,
    dilation: 10,
    tubeScale: { head: 1.5, torso: 1.9, limb: 0.55, hand: 1.35, finger: 0.75, leg: 0.7 },
    // Colores del visor (cian = servo OK, ámbar = pendiente, magenta = alerta).
    colors: { accent: 0x35f0ff, warn: 0xffb03a, danger: 0xff2e63, ok: 0x6cff9b },
  },

  /** Parámetros de proyección del modo visor (2D sobre el video). */
  visor: {
    depthPlane: 1.0,
    fov: 50,
    /** Cuánto peso tiene landmark.z en la profundidad del rig (mm relativas). */
    zScale: 1.0,
    grabRadius: 0.085,
  },

  /** Parámetros del modo VR/AR inmersivo (unidades = metros). */
  xr: {
    bodyDistance: 0.42,
    chestHeight: 1.15,
    grabRadius: 0.09,
    coreOrbitRadius: 0.55,
  },

  game: {
    roundSeconds: 95,
    maxCores: 5,
    coreSpawnSeconds: 2.6,
    coreDriftSpeed: 0.055,
    comboWindowSeconds: 5.5,
    comboStep: 0.25,
    comboMax: 5,
    integrityMax: 100,
    penaltyLostCore: 9,
    penaltyWrongSocket: 7,
    penaltyNotHuman: 12,
    points: { gesture: 90, place: 160, scan: 240, switchCam: 120, roundClear: 400, perfect: 300 },
    upgradePointsPerLevel: 50,
    maxPartLevel: 4,
  },

  storageKeys: {
    best: 'robovisor.best.v1',
    prefs: 'robovisor.prefs.v1',
    modelCache: 'robovisor.models.v1',
  },
};

/** Partes del cuerpo humanas que el visor puede robotizar / mejorar. */
export const BODY_PARTS = [
  { id: 'cabeza', label: 'Cráneo / visor', group: 'head', sockets: 2, desc: 'Placa óptica y sensores oculares.' },
  { id: 'torso', label: 'Torso', group: 'torso', sockets: 3, desc: 'Reactor pectoral y espina de servo.' },
  { id: 'brazo_izq', label: 'Brazo izq.', group: 'armL', sockets: 2, desc: 'Hidráulica del hombro al codo.' },
  { id: 'brazo_der', label: 'Brazo der.', group: 'armR', sockets: 2, desc: 'Hidráulica del hombro al codo.' },
  { id: 'mano_izq', label: 'Mano izq.', group: 'handL', sockets: 2, desc: 'Manipulador de 5 dedos.' },
  { id: 'mano_der', label: 'Mano der.', group: 'handR', sockets: 2, desc: 'Manipulador de 5 dedos.' },
  { id: 'pierna_izq', label: 'Pierna izq.', group: 'legL', sockets: 1, desc: 'Actuador de rodilla y tobillo.' },
  { id: 'pierna_der', label: 'Pierna der.', group: 'legR', sockets: 1, desc: 'Actuador de rodilla y tobillo.' },
];

export const PART_BY_ID = Object.fromEntries(BODY_PARTS.map((p) => [p.id, p]));

/** Gestos reconocidos (calculados con landmarks de mano). */
export const GESTURES = [
  { id: 'punho', label: 'Puño', icon: '✊', hint: 'Cierra la mano completa.' },
  { id: 'palma', label: 'Palma abierta', icon: '🖐', hint: 'Abre los cinco dedos.' },
  { id: 'pinza', label: 'Pinza', icon: '🤏', hint: 'Junta pulgar e índice.' },
  { id: 'indice', label: 'Señalar', icon: '☝', hint: 'Solo el índice extendido.' },
  { id: 'paz', label: 'Paz / V', icon: '✌', hint: 'Índice y medio extendidos.' },
  { id: 'pulgar', label: 'Pulgar arriba', icon: '👍', hint: 'Puño con el pulgar arriba.' },
];

export const GESTURE_BY_ID = Object.fromEntries(GESTURES.map((g) => [g.id, g]));

/** Texto de la interfaz, en un solo lugar para mantener el resto del código limpio. */
export const T = {
  title: 'ROBOVISOR AR',
  subtitle: 'Visor robótico corporal · cámara · VR',
  brief: [
    'Apunta la cámara a tu cuerpo: solo las partes humanas detectadas se convierten en robótica.',
    'Atrapa núcleos de servo con una PINZA y conéctalos en el zócalo corporal que pida el protocolo.',
    'Usa la cámara FRONTAL y la TRASERA: con la trasera escaneas a otras personas y desbloqueas mejoras.',
  ],
};

export default CONFIG;
