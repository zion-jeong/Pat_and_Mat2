// 작업 목록 3D 배치 화면: Gazebo coating_factory 월드 좌표(m, Z 위)를 그대로 사용
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

export function createWork3D({ canvas, hShape, onAdd, onSelect, onDrag, onHover }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI * 0.49;          // 바닥 아래로 내려가지 않게
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 2.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(20, -10, 30);
  scene.add(sun);

  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const staticG = new THREE.Group(), dynG = new THREE.Group();
  scene.add(staticG, dynG);
  let built = false, active = false, data = null;

  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.75, ...extra });
  const steel = mat(0x8e979f, { metalness: 0.55, roughness: 0.45 });
  const steelSel = mat(0xe2561b, { metalness: 0.3, roughness: 0.5 });
  const steelRun = mat(0xc2681f, { metalness: 0.3, roughness: 0.5 });
  const capMat = new THREE.MeshBasicMaterial({ color: 0x2f8a4a, side: THREE.DoubleSide });

  function sprite(text, { color = '#16191d', bg = 'rgba(255,255,255,.9)', w = 256, h = 96, font = 'bold 44px system-ui, sans-serif' } = {}) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (bg) { g.fillStyle = bg; g.beginPath(); g.roundRect(4, 4, w - 8, h - 8, 18); g.fill(); }
    g.fillStyle = color; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 2);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    s.renderOrder = 10;
    return s;
  }
  function plusSprite() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.strokeStyle = '#e2561b'; g.lineWidth = 9;
    g.beginPath(); g.arc(64, 64, 52, 0, Math.PI * 2); g.fill(); g.stroke();
    g.lineCap = 'round'; g.lineWidth = 12;
    g.beginPath(); g.moveTo(36, 64); g.lineTo(92, 64); g.moveTo(64, 36); g.lineTo(64, 92); g.stroke();
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    s.renderOrder = 11;
    return s;
  }

  function buildStatic(d) {
    const { factory: F, stations, saddleY, supportZ, laneY } = d;
    const fw = F.x[1] - F.x[0], fl = F.y[1] - F.y[0];
    const floor = new THREE.Mesh(new THREE.BoxGeometry(fw, fl, 0.1), mat(0xd9dcdf));
    floor.position.set((F.x[0] + F.x[1]) / 2, (F.y[0] + F.y[1]) / 2, -0.05);
    staticG.add(floor);
    const grid = new THREE.GridHelper(Math.max(fw, fl), Math.max(fw, fl) / 2, 0xb8bdc2, 0xc8ccd0);
    grid.rotation.x = Math.PI / 2;
    grid.position.set((F.x[0] + F.x[1]) / 2, (F.y[0] + F.y[1]) / 2, 0.005);
    staticG.add(grid);
    // 벽(낮게) — 입구(+X)는 열림
    const wallM = mat(0xa9b0b6, { transparent: true, opacity: 0.55 });
    const wall = (x, y, sx, sy) => { const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 2.5), wallM); m.position.set(x, y, 1.25); staticG.add(m); };
    wall(F.x[0], (F.y[0] + F.y[1]) / 2, 0.3, fl);
    wall((F.x[0] + F.x[1]) / 2, F.y[0], fw, 0.3);
    wall((F.x[0] + F.x[1]) / 2, F.y[1], fw, 0.3);
    const ent = new THREE.Mesh(new THREE.BoxGeometry(0.15, fl, 0.02), new THREE.MeshBasicMaterial({ color: 0xe2561b }));
    ent.position.set(F.x[1], (F.y[0] + F.y[1]) / 2, 0.02);
    staticG.add(ent);
    const entL = sprite('입구 (+X)', { color: '#e2561b' }); entL.scale.set(4.2, 1.6, 1); entL.position.set(F.x[1] + 1, laneY[0], 1); staticG.add(entL);

    const laneM = new THREE.MeshBasicMaterial({ color: 0xc9ced3, transparent: true, opacity: 0.6 });
    const saddleM = mat(0x6d757d);
    for (const st of stations) {
      const lane = new THREE.Mesh(new THREE.PlaneGeometry(1.4, laneY[1] - laneY[0]), laneM);
      lane.position.set(st.x, (laneY[0] + laneY[1]) / 2, 0.012);
      staticG.add(lane);
      for (const y of saddleY) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(1, 1, supportZ), saddleM);
        s.position.set(st.x, y, supportZ / 2);
        staticG.add(s);
      }
      const l = sprite(st.id); l.scale.set(2.4, 0.9, 1); l.position.set(st.x, laneY[0] - 1.4, 0.6); staticG.add(l);
    }
    const sup = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, 1.2), mat(0xc9a227));
    sup.position.set(-0.5, -17.85 + 0.8, 0.6); staticG.add(sup);
    const supL = sprite('도료 공급대'); supL.scale.set(4.2, 1.6, 1); supL.position.set(-0.5, -15.6, 2.4); staticG.add(supL);
    const robot = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.8, 1.2), mat(0x3a8dde));
    robot.position.set(1.5, -16, 0.6); robot.rotation.z = Math.PI / 2; staticG.add(robot);
    const robL = sprite('로봇', { color: '#2f74b8' }); robL.scale.set(2.4, 0.9, 1); robL.position.set(1.5, -16, 2.0); staticG.add(robL);
    const worker = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.8, 16), mat(0xe2b13c));
    worker.rotation.x = Math.PI / 2; worker.position.set(13, -3, 0.9); staticG.add(worker);
    built = true;
  }

  // 빔 형상: Shape(x=부재 Y, y=부재 Z, 돌출=부재 X)를 월드로. 부재 Y(+좌)는 yaw ±90°에 따라 월드 ∓X
  function beamMatrix(o, dir) {
    return new THREE.Matrix4().set(-dir, 0, 0, o.x, 0, 0, dir, o.y, 0, 1, 0, o.z, 0, 0, 0, 1);
  }
  const dispose = (o) => o.traverse((c) => { c.geometry?.dispose(); if (c.material?.map) c.material.map.dispose(); });
  let pickBeams = [], pickAdds = [];
  function buildDynamic(d) {
    dispose(dynG); dynG.clear();
    pickBeams = []; pickAdds = [];
    const placed = new Set(d.beams.map((b) => b.station));
    for (const b of d.beams) {
      const st = d.stations.find((s) => s.id === b.station);
      const L = b.L, dir = b.dir;
      const y0 = dir > 0 ? b.yc - L / 2 : b.yc + L / 2;
      const shape = hShape(b.spec);
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false }), b.sel ? steelSel : b.run ? steelRun : steel);
      const cap = new THREE.Mesh(new THREE.ShapeGeometry(shape), capMat);
      const m = beamMatrix({ x: st.x, y: y0, z: d.supportZ }, dir);
      for (const o of [body, cap]) { o.matrixAutoUpdate = false; o.matrix.copy(m); }
      cap.matrix.multiply(new THREE.Matrix4().makeTranslation(0, 0, -0.01));
      body.userData.beamId = b.id;
      g.add(body, cap);
      const lab = sprite(`${b.member} · ${L} m`, { w: 384 }); lab.scale.set(3.6, 0.9, 1);
      lab.position.set(st.x, b.yc, d.supportZ + b.spec.H / 1000 + 0.9);
      g.add(lab);
      dynG.add(g);
      pickBeams.push(body);
    }
    if (d.showAdd) {
      for (const st of d.stations) {
        if (placed.has(st.id)) continue;
        const p = plusSprite(); p.scale.set(1.3, 1.3, 1);
        p.position.set(st.x, d.laneMid, d.supportZ + 0.7);
        p.userData.station = st.id;
        dynG.add(p); pickAdds.push(p);
      }
    }
  }

  function update(d) {
    data = d;
    if (!built) { buildStatic(d); resize(); home(); }
    buildDynamic(d);
  }
  // 입구(+X) 쪽 위에서 받침대 8줄 전체가 보이도록
  function home() {
    controls.target.set(-2.5, 5.5, 0);
    const fit = Math.max(1, 1.45 / Math.max(camera.aspect, 0.5));   // 좁은 화면일수록 더 멀리
    camera.position.set(-2.5 + 24 * fit, 5.5 - 3 * fit, 30 * fit);
    controls.update();
  }
  function resize() {
    const r = canvas.parentElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);

  // 포인터: ＋ 누르기, 빔 고르기, 빔 끌기(Y 방향)
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  const setRay = (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  };
  const hitPlane = (z) => { const p = new THREE.Vector3(); return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p) ? p : null; };
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || !data) return;
    setRay(e);
    const add = ray.intersectObjects(pickAdds, false)[0];
    const beam = ray.intersectObjects(pickBeams, false)[0];
    down = { x: e.clientX, y: e.clientY, add: add?.object.userData.station, beam: beam?.object.userData.beamId };
    if (down.beam && !data.lock) {
      const b = data.beams.find((x) => x.id === down.beam);
      down.z = beam.point.z; down.p0 = hitPlane(down.z); down.yc0 = b.yc;
      controls.enabled = false;
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) {                                    // 마우스 올림 표시
      if (e.pointerType === 'mouse' && data) {
        setRay(e);
        const over = ray.intersectObjects([...pickAdds, ...pickBeams], false)[0];
        canvas.style.cursor = over ? 'pointer' : 'grab';
        onHover?.(over?.object.userData.station ?? null);
      }
      return;
    }
    if (!down.p0) return;
    setRay(e);
    const p = hitPlane(down.z);
    if (!p) return;
    const dy = p.y - down.p0.y;
    if (Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y) > 4) down.moved = true;
    if (down.moved) onDrag(down.beam, down.yc0 + dy);
  });
  const up = (e) => {
    if (!down) return;
    const d = down; down = null;
    controls.enabled = true;
    const moved = d.moved || Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 6;
    if (moved && !d.beam) return;                    // 화면 회전이었음
    if (d.beam) onSelect(d.beam, moved);
    else if (d.add) onAdd(d.add);
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', () => { down = null; controls.enabled = true; });

  (function loop() {
    if (active) {
      const bg = css('--view-bg');
      if (bg && (!scene.background || scene.background.getHexString() !== new THREE.Color(bg).getHexString())) scene.background = new THREE.Color(bg);
      controls.update();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  })();

  return {
    update,
    home,
    setActive(v) { active = v; if (v) requestAnimationFrame(() => { const first = !camera.userData.sized; resize(); if (first && camera.aspect !== 1) { camera.userData.sized = true; home(); } }); },
    // 화면 좌표(px) 계산용 (테스트)
    project(kind, key) {
      const o = (kind === 'add' ? pickAdds.find((x) => x.userData.station === key) : pickBeams.find((x) => x.userData.beamId === key));
      if (!o) return null;
      const v = new THREE.Vector3();
      if (kind === 'add') v.copy(o.position);
      else { o.geometry.computeBoundingBox(); o.geometry.boundingBox.getCenter(v); v.applyMatrix4(o.matrix); }
      v.project(camera);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    },
  };
}
