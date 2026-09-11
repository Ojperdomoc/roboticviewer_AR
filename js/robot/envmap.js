/**
 * envmap.js — entorno procedural (sin assets externos).
 *
 *  - `studioEnv()`: genera una escena de "tiras de estudio" y la convierte en un
 *    environment map con PMREM, para que el metal del rig se vea real sin descargar
 *    un HDR de varios MB.
 *  - `holoRoom()`: rejilla + neblina + anillos de suelo para el modo VR/gafas, donde
 *    no hay video de fondo.
 */

export function studioEnv(THREE, renderer) {
  try {
    const scene = new THREE.Scene();
    const back = new THREE.Color(0x0a1016);
    scene.background = back;
    const strip = (w, h, x, y, z, color, i = 3) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color }));
      m.position.set(x, y, z);
      m.lookAt(0, 0, 0);
      m.material.toneMapped = false;
      void i;
      scene.add(m);
    };
    strip(6, 1.4, 0, 2.6, -1.2, 0x9fe8ff);
    strip(2.4, 5, -3.2, 0.4, 0.6, 0xffb03a);
    strip(2.4, 5, 3.2, 0.4, 0.6, 0x35f0ff);
    strip(8, 3, 0, -1.8, 2.4, 0x24323c);
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromScene(scene, 0.035);
    pmrem.dispose();
    for (const o of scene.children) { o.geometry.dispose(); o.material.dispose(); }
    return rt.texture;
  } catch (err) {
    console.warn('[env] sin environment map:', err?.message);
    return null;
  }
}

/** Escenario holográfico para VR / modo gafas. */
export function holoRoom(THREE, { color = 0x0b1a22, accent = 0x35f0ff } = {}) {
  const group = new THREE.Group();
  group.name = 'holo-room';

  const grid = new THREE.GridHelper(12, 48, accent, 0x1d3a46);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  grid.position.y = -0.02;
  group.add(grid);

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(9, 24, 16),
    new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, fog: true })
  );
  group.add(sky);

  // Anillos de "plataforma de calibración".
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.1 + i * 0.45, 0.008 + i * 0.002, 6, 72),
      new THREE.MeshBasicMaterial({ color: i === 1 ? 0xffb03a : accent, transparent: true, opacity: 0.42 - i * 0.08, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.001 + i * 0.002;
    group.add(ring);
  }

  // Pilares lejanos para dar profundidad en estéreo.
  const pillarMat = new THREE.MeshStandardMaterial({ color: 0x16242d, metalness: 0.9, roughness: 0.5 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.32, 3.4, 0.32), pillarMat);
    p.position.set(Math.cos(a) * 5.2, 1.6, Math.sin(a) * 5.2);
    group.add(p);
  }
  return {
    group,
    spin(dt) {
      for (const c of group.children) {
        if (c.geometry?.type === 'TorusGeometry') c.rotation.z += dt * 0.12;
      }
    },
    dispose() {
      group.traverse((o) => { o.geometry?.dispose?.(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.()); });
    },
  };
}
