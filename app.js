import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { HBEAM_SPECS, HBEAM_SOURCE } from './hbeam_specs.js';

const SNAP = 5;            // mm
const MIN_SIZE = 10;       // mm, 이보다 작은 드래그는 무시
const DRAFT_KEY = 'steelcoat-web-draft-v1';
const $ = (id) => document.getElementById(id);

// ---------- 상태 ----------
const state = {
  specNo: 45,              // H-400×200×8×13
  length: 6000,
  member: '',
  client: '',
  zones: [],               // {id, face:'all'|faceId, start, end, from?, to?}
  selected: null,
  mode: 'view',
  fullWidth: false,
};
let nextId = 1;

const spec = () => HBEAM_SPECS.find((s) => s.no === state.specNo);
const specString = (s) => `H-${s.H} × ${s.B} × ${s.t1} × ${s.t2}`;
const snap = (v) => Math.round(v / SNAP) * SNAP;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 도장 면 10개. planner.py와 같은 이름·좌표계(X 길이, Y 폭 +좌, Z 높이).
// axis: 면 안의 가로 좌표가 Y인지 Z인지. from/to는 이 좌표값(mm).
function faces(s) {
  const { H: h, B: b, t1: tw, t2: tf } = s;
  return [
    { id: 'top_outer', label: '상부 플랜지 윗면', axis: 'y', plane: ['z', h], lo: -b / 2, hi: b / 2, n: [0, 0, 1] },
    { id: 'bottom_outer', label: '하부 플랜지 아랫면', axis: 'y', plane: ['z', 0], lo: -b / 2, hi: b / 2, n: [0, 0, -1] },
    { id: 'top_inner_left', label: '상부 플랜지 안쪽(좌)', axis: 'y', plane: ['z', h - tf], lo: tw / 2, hi: b / 2, n: [0, 0, -1] },
    { id: 'top_inner_right', label: '상부 플랜지 안쪽(우)', axis: 'y', plane: ['z', h - tf], lo: -b / 2, hi: -tw / 2, n: [0, 0, -1] },
    { id: 'bottom_inner_left', label: '하부 플랜지 안쪽(좌)', axis: 'y', plane: ['z', tf], lo: tw / 2, hi: b / 2, n: [0, 0, 1] },
    { id: 'bottom_inner_right', label: '하부 플랜지 안쪽(우)', axis: 'y', plane: ['z', tf], lo: -b / 2, hi: -tw / 2, n: [0, 0, 1] },
    { id: 'web_left', label: '웹 좌측면', axis: 'z', plane: ['y', tw / 2], lo: tf, hi: h - tf, n: [0, 1, 0] },
    { id: 'web_right', label: '웹 우측면', axis: 'z', plane: ['y', -tw / 2], lo: tf, hi: h - tf, n: [0, -1, 0] },
  ];
}
const faceById = (id) => faces(spec()).find((f) => f.id === id);

// 면 좌표 (x, u) → 부재 좌표 (X, Y, Z), 법선 방향으로 off 만큼 띄움
function facePoint(f, x, u, off = 0) {
  const p = { x, y: 0, z: 0 };
  p[f.plane[0]] = f.plane[1];
  p[f.axis] = u;
  return new THREE.Vector3(p.x + f.n[0] * off, p.y + f.n[1] * off, p.z + f.n[2] * off);
}
function quadGeom(f, x0, x1, u0, u1, off) {
  const a = facePoint(f, x0, u0, off), b = facePoint(f, x1, u0, off);
  const c = facePoint(f, x1, u1, off), d = facePoint(f, x0, u1, off);
  // 앞면이 면의 바깥 법선을 향하도록 감기 순서 맞춤 (클릭 감지는 앞면만 함)
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
  const front = n.dot(new THREE.Vector3(...f.n)) >= 0;
  const g = new THREE.BufferGeometry().setFromPoints(front ? [a, b, c, a, c, d] : [a, c, b, a, d, c]);
  g.computeVertexNormals();
  return g;
}

// ---------- 3D ----------
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 10, 200000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-3000, -4000, 6000);
scene.add(sun);

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const root = new THREE.Group();          // 부재 좌표계, x를 가운데로 이동
scene.add(root);
let beamGroup = null, pickMeshes = [], solidMeshes = [], zoneGroup = new THREE.Group(), preview = null;
root.add(zoneGroup);

const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa2aa, metalness: 0.55, roughness: 0.5 });
const pickMat = new THREE.MeshBasicMaterial({ visible: false });
const zoneMat = new THREE.MeshBasicMaterial({ color: 0xd62f2f, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
const selMat = new THREE.MeshBasicMaterial({ color: 0xe2561b, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
const prevMat = new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
const hoverMat = new THREE.MeshBasicMaterial({ color: 0x3a8dde, transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false });
let hoverMesh = null;

function textSprite(text, color = '#16191d') {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.roundRect(4, 14, 248, 68, 14); g.fill();
  g.fillStyle = color; g.font = 'bold 40px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 49);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.renderOrder = 10;
  return s;
}

function buildBeam() {
  if (beamGroup) { root.remove(beamGroup); beamGroup.traverse((o) => o.geometry?.dispose()); }
  const s = spec(), L = state.length;
  const { H: h, B: b, t1: tw, t2: tf } = s;
  beamGroup = new THREE.Group();
  solidMeshes = [];
  const box = (sx, sy, sz, cz) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(L, sy, sz), steelMat);
    m.position.set(L / 2, 0, cz);
    beamGroup.add(m); solidMeshes.push(m);
  };
  box(L, b, tf, tf / 2);              // 하부 플랜지
  box(L, b, tf, h - tf / 2);          // 상부 플랜지
  box(L, tw, h - 2 * tf, h / 2);      // 웹
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.ExtrudeGeometry(hShape(s), { depth: L, bevelEnabled: false })),
    new THREE.LineBasicMaterial({ color: 0x3b4148 }));
  toMember(edges, 0);
  beamGroup.add(edges);

  pickMeshes = faces(s).map((f) => {
    const m = new THREE.Mesh(quadGeom(f, 0, L, f.lo, f.hi, 0.5), pickMat);
    m.userData.face = f;
    beamGroup.add(m);
    return m;
  });

  // 시작단(X=0) 표시와 길이 눈금
  const cap = new THREE.Mesh(new THREE.ShapeGeometry(hShape(s)),
    new THREE.MeshBasicMaterial({ color: 0x2f8a4a, side: THREE.DoubleSide }));
  toMember(cap, -1);
  beamGroup.add(cap);
  const label0 = textSprite('X = 0', '#2f8a4a');
  const labelL = textSprite(`${L} mm`);
  const sc = Math.max(h, b) * 0.9;
  [label0, labelL].forEach((sp) => sp.scale.set(sc * 2.6, sc, 1));
  label0.position.set(0, 0, h + sc * 0.9);
  labelL.position.set(L, 0, h + sc * 0.9);
  beamGroup.add(label0, labelL);
  const tickPts = [];
  for (let x = 0; x <= L; x += 500) {
    const k = x % 1000 === 0 ? 1 : 0.5;
    tickPts.push(new THREE.Vector3(x, -b / 2 - 20, 0), new THREE.Vector3(x, -b / 2 - 20 - 60 * k, 0));
  }
  tickPts.push(new THREE.Vector3(0, -b / 2 - 20, 0), new THREE.Vector3(L, -b / 2 - 20, 0));
  beamGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(tickPts),
    new THREE.LineBasicMaterial({ color: 0x5d6670 })));

  root.add(beamGroup);
  root.position.x = -L / 2;
  renderZones();
}

// Shape 좌표(x=Y, y=Z, 돌출 z=X) → 부재 좌표
function toMember(obj, x) {
  obj.matrixAutoUpdate = false;
  obj.matrix.set(0, 0, 1, x, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
}

// H 단면 외곽선 (Y-Z 평면, Shape의 x=Y, y=Z)
function hShape(s) {
  const { H: h, B: b, t1: tw, t2: tf } = s;
  const p = [[-b/2,0],[b/2,0],[b/2,tf],[tw/2,tf],[tw/2,h-tf],[b/2,h-tf],[b/2,h],[-b/2,h],[-b/2,h-tf],[-tw/2,h-tf],[-tw/2,tf],[-b/2,tf]];
  return new THREE.Shape(p.map(([y, z]) => new THREE.Vector2(y, z)));
}

function renderZones() {
  zoneGroup.children.forEach((m) => m.geometry.dispose());
  zoneGroup.clear();
  const fs = faces(spec());
  for (const z of state.zones) {
    const targets = z.face === 'all' ? fs : [fs.find((f) => f.id === z.face)].filter(Boolean);
    for (const f of targets) {
      const u0 = z.face === 'all' ? f.lo : z.from, u1 = z.face === 'all' ? f.hi : z.to;
      const m = new THREE.Mesh(quadGeom(f, z.start, z.end, u0, u1, 1.5), z.id === state.selected ? selMat : zoneMat);
      m.userData.zoneId = z.id;
      m.renderOrder = 2;
      zoneGroup.add(m);
    }
  }
}

function setView(kind) {
  const s = spec(), L = state.length;
  // 부재 전체가 화면 폭에 들어오는 거리
  const half = THREE.MathUtils.degToRad(camera.fov / 2);
  const hHalf = Math.atan(Math.tan(half) * (camera.aspect > 0.2 ? camera.aspect : 1.5));
  const d = Math.max((L * 0.58) / Math.tan(Math.min(half, hHalf)), s.H * 6);
  const t = new THREE.Vector3(0, 0, s.H / 2);
  const pos = {
    iso: [-d * 0.15, -d * 0.9, d * 0.4],
    top: [0, -d * 0.02, d * 1.1],
    bottom: [0, -d * 0.02, -d * 1.1],
    left: [0, d * 1.05, s.H / 2],    // +Y 쪽에서 봄
    right: [0, -d * 1.05, s.H / 2],  // -Y 쪽에서 봄
  }[kind];
  camera.position.set(...pos);
  controls.target.copy(t);
  controls.update();
}

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

function applyTheme() {
  scene.background = new THREE.Color(css('--view-bg') || '#e7e9ec');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

if (location.hash === '#debug') window.__sc = { THREE, camera, controls, state, faces: () => faces(spec()) };

(function loop() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
})();

// ---------- 포인터: 면 위 드래그로 사각형 ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag = null;
const touches = new Set();
canvas.addEventListener('pointerdown', (e) => {
  touches.add(e.pointerId);
  if (touches.size > 1 && drag) cancelDrag();   // 두 손가락 = 확대/이동
}, true);
const lift = (e) => touches.delete(e.pointerId);
canvas.addEventListener('pointerup', lift, true);
canvas.addEventListener('pointercancel', lift, true);
function cancelDrag() {
  drag = null;
  if (preview) { zoneGroup.remove(preview); preview.geometry.dispose(); preview = null; }
  hud('');
}

function setRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function pickFace(e) {
  setRay(e);
  const hit = ray.intersectObjects([...pickMeshes, ...solidMeshes], false)[0];
  if (!hit || !hit.object.userData.face) return null;
  const f = hit.object.userData.face;
  const p = root.worldToLocal(hit.point.clone());
  return { f, x: p.x, u: p[f.axis] };
}
function pickZone(e) {
  setRay(e);
  const hit = ray.intersectObjects(zoneGroup.children, false)[0];
  return hit ? hit.object.userData.zoneId : null;
}
// 드래그 중에는 처음 고른 면의 무한 평면과 교차 (면 밖으로 나가도 끊기지 않게)
function onFacePlane(e, f) {
  setRay(e);
  const n = new THREE.Vector3(...f.n);
  const p0 = root.localToWorld(facePoint(f, 0, (f.lo + f.hi) / 2));
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p0);
  const out = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, out)) return null;
  const p = root.worldToLocal(out);
  return { x: clamp(snap(p.x), 0, state.length), u: clamp(p[f.axis], f.lo, f.hi) };
}
function rectOf(f, a, b) {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  let u0 = Math.min(a.u, b.u), u1 = Math.max(a.u, b.u);
  if (state.fullWidth) { u0 = f.lo; u1 = f.hi; }
  else {
    u0 = clamp(snap(u0), f.lo, f.hi); u1 = clamp(snap(u1), f.lo, f.hi);
    if (f.lo - u0 > -SNAP) u0 = f.lo;           // 가장자리 근처면 면 끝까지
    if (f.hi - u1 < SNAP) u1 = f.hi;
  }
  return { x0, x1, u0: +u0.toFixed(1), u1: +u1.toFixed(1) };
}

canvas.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'draw' || e.button !== 0 || !e.isPrimary || touches.size > 1) return;
  const z = pickZone(e);
  const hit = pickFace(e);
  if (!hit) { if (z) select(z); return; }
  drag = { f: hit.f, a: { x: clamp(snap(hit.x), 0, state.length), u: hit.u }, zone: z, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) { hover(e); return; }
  const b = onFacePlane(e, drag.f);
  if (!b) return;
  drag.b = b;
  const r = rectOf(drag.f, drag.a, b);
  drag.moved = drag.moved || (r.x1 - r.x0 >= MIN_SIZE);
  if (preview) { zoneGroup.remove(preview); preview.geometry.dispose(); }
  preview = new THREE.Mesh(quadGeom(drag.f, r.x0, Math.max(r.x1, r.x0 + 1), r.u0, r.u1, 2), prevMat);
  preview.renderOrder = 3;
  zoneGroup.add(preview);
  hud(`${drag.f.label} · X ${r.x0}–${r.x1} · ${drag.f.axis.toUpperCase()} ${r.u0}–${r.u1} mm`);
});
const endDrag = () => {
  if (!drag) return;
  if (preview) { zoneGroup.remove(preview); preview.geometry.dispose(); preview = null; }
  const { f, a, b, moved, zone } = drag;
  drag = null;
  hud('');
  if (!moved || !b) { if (zone) select(zone); return; }
  const r = rectOf(f, a, b);
  if (r.x1 - r.x0 < MIN_SIZE || r.u1 - r.u0 < 1) return;
  addZone({ face: f.id, start: r.x0, end: r.x1, from: r.u0, to: r.u1 });
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', cancelDrag);

function hover(e) {
  if (hoverMesh) { root.remove(hoverMesh); hoverMesh.geometry.dispose(); hoverMesh = null; }
  if (state.mode !== 'draw' || e.pointerType === 'touch') return hud('');
  const hit = pickFace(e);
  if (!hit) return hud('');
  const f = hit.f;
  hoverMesh = new THREE.Mesh(quadGeom(f, 0, state.length, f.lo, f.hi, 1), hoverMat);
  root.add(hoverMesh);
  hud(`${f.label} · X ${Math.round(hit.x)} mm`);
}
canvas.addEventListener('pointerleave', () => { if (hoverMesh) { root.remove(hoverMesh); hoverMesh = null; } hud(''); });
const hud = (t) => { $('hud').textContent = t; };

// ---------- 영역 목록 ----------
function addZone(z) {
  z.id = nextId++;
  state.zones.push(z);
  state.selected = z.id;
  changed();
}
function select(id) {
  state.selected = id;
  renderZones(); renderList();
  document.querySelector(`.zone[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderList() {
  const ol = $('zones');
  ol.replaceChildren();
  $('zoneEmpty').hidden = state.zones.length > 0;
  const fs = faces(spec());
  state.zones.forEach((z, i) => {
    const li = document.createElement('li');
    li.className = 'zone' + (z.id === state.selected ? ' sel' : '');
    li.dataset.id = z.id;
    const f = fs.find((x) => x.id === z.face);
    const opts = [['all', '전체 면 (길이 구간)'], ...fs.map((x) => [x.id, x.label])]
      .map(([v, t]) => `<option value="${v}"${v === z.face ? ' selected' : ''}>${t}</option>`).join('');
    const ax = f ? f.axis.toUpperCase() : '';
    li.innerHTML = `
      <div class="top"><b>${i + 1}</b><select data-k="face" aria-label="면">${opts}</select><button type="button" data-del>삭제</button></div>
      <div class="nums${f ? '' : ' two'}">
        <label>시작 X<input type="number" step="${SNAP}" data-k="start" value="${z.start}"></label>
        <label>끝 X<input type="number" step="${SNAP}" data-k="end" value="${z.end}"></label>
        ${f ? `<label>${ax} 부터<input type="number" step="${SNAP}" data-k="from" value="${z.from}"></label>
        <label>${ax} 까지<input type="number" step="${SNAP}" data-k="to" value="${z.to}"></label>` : ''}
      </div>`;
    li.addEventListener('pointerdown', () => { if (state.selected !== z.id) { state.selected = z.id; renderZones(); ol.querySelectorAll('.zone').forEach((n) => n.classList.toggle('sel', +n.dataset.id === z.id)); } });
    li.querySelector('[data-del]').onclick = () => {
      state.zones = state.zones.filter((x) => x.id !== z.id);
      changed();
    };
    li.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      if (k === 'face') {
        const nf = fs.find((x) => x.id === inp.value);
        z.face = inp.value;
        if (nf) { z.from = nf.lo; z.to = nf.hi; } else { delete z.from; delete z.to; }
      } else z[k] = Number(inp.value);
      normalizeZone(z);
      changed();
    }));
    ol.append(li);
  });
}

function normalizeZone(z) {
  const L = state.length;
  z.start = clamp(Number(z.start) || 0, 0, L);
  z.end = clamp(Number(z.end) || 0, 0, L);
  if (z.end < z.start) [z.start, z.end] = [z.end, z.start];
  const f = z.face !== 'all' && faceById(z.face);
  if (z.face !== 'all' && !f) { z.face = 'all'; }
  if (f) {
    z.from = clamp(Number(z.from), f.lo, f.hi);
    z.to = clamp(Number(z.to), f.lo, f.hi);
    if (!Number.isFinite(z.from)) z.from = f.lo;
    if (!Number.isFinite(z.to)) z.to = f.hi;
    if (z.to < z.from) [z.from, z.to] = [z.to, z.from];
  } else { delete z.from; delete z.to; }
}

// 면적: 면별로 사각형 합집합(좌표 압축)
function stats() {
  const fs = faces(spec()), L = state.length;
  let total = 0, excl = 0;
  for (const f of fs) {
    total += L * (f.hi - f.lo);
    const rs = state.zones.filter((z) => z.face === 'all' || z.face === f.id)
      .map((z) => z.face === 'all' ? [z.start, z.end, f.lo, f.hi] : [z.start, z.end, z.from, z.to])
      .filter(([a, b, c, d]) => b > a && d > c);
    if (!rs.length) continue;
    const xs = [...new Set(rs.flatMap((r) => [r[0], r[1]]))].sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i++) {
      const xm = (xs[i] + xs[i + 1]) / 2;
      const iv = rs.filter((r) => r[0] <= xm && xm <= r[1]).map((r) => [r[2], r[3]]).sort((a, b) => a[0] - b[0]);
      let cov = 0, cur = null;
      for (const [a, b] of iv) {
        if (!cur || a > cur[1]) { if (cur) cov += cur[1] - cur[0]; cur = [a, b]; }
        else cur[1] = Math.max(cur[1], b);
      }
      if (cur) cov += cur[1] - cur[0];
      excl += cov * (xs[i + 1] - xs[i]);
    }
  }
  const m2 = (v) => (v / 1e6).toFixed(2);
  $('stats').innerHTML = `<div><b>${m2(total)}</b><span>대상 면적 m²</span></div>
    <div><b>${m2(excl)}</b><span>금지 m²</span></div>
    <div><b>${m2(total - excl)}</b><span>도장 m²</span></div>`;
}

function changed() {
  state.zones.forEach(normalizeZone);
  renderZones(); renderList(); stats(); saveDraft();
  $('msg').textContent = '';
}

// ---------- 규격 선택 ----------
function fillNominals() {
  const noms = [...new Set(HBEAM_SPECS.map((s) => s.nominal))];
  $('nominal').innerHTML = noms.map((n) => `<option>${n}</option>`).join('');
}
function fillSections() {
  const s = spec();
  $('nominal').value = s.nominal;
  $('section').innerHTML = HBEAM_SPECS.filter((x) => x.nominal === s.nominal)
    .map((x) => `<option value="${x.no}">${x.H}×${x.B}×${x.t1}×${x.t2}</option>`).join('');
  $('section').value = s.no;
  $('specInfo').textContent = `KS 번호 ${s.no} · r ${s.r} mm · ${s.kg_m} kg/m · 부재 중량 약 ${(s.kg_m * state.length / 1000).toFixed(0)} kg`;
}
function specChanged(resetView) {
  fillSections();
  buildBeam();
  changed();
  if (resetView) setView('iso');
}
$('nominal').onchange = () => {
  state.specNo = HBEAM_SPECS.find((x) => x.nominal === $('nominal').value).no;
  specChanged(true);
};
$('section').onchange = () => { state.specNo = Number($('section').value); specChanged(true); };
$('length').onchange = () => {
  const v = clamp(Math.round(Number($('length').value) || 6000), 500, 30000);
  $('length').value = v;
  state.length = v;
  specChanged(true);
};
$('member').oninput = () => { state.member = $('member').value.trim(); saveDraft(); };
$('client').oninput = () => { state.client = $('client').value.trim(); saveDraft(); };

// ---------- 모드·버튼 ----------
function setMode(m) {
  state.mode = m;
  $('modeView').setAttribute('aria-pressed', m === 'view');
  $('modeDraw').setAttribute('aria-pressed', m === 'draw');
  controls.enableRotate = m === 'view';   // 그리기 모드: 한 손가락 = 그리기, 두 손가락 = 확대/이동
  canvas.style.cursor = m === 'draw' ? 'crosshair' : 'grab';
}
$('modeView').onclick = () => setMode('view');
$('modeDraw').onclick = () => setMode('draw');
$('fullWidth').onchange = () => { state.fullWidth = $('fullWidth').checked; };
$('addAll').onclick = () => {
  const L = state.length, len = Math.min(250, L);
  addZone({ face: 'all', start: 0, end: len });
};
$('undo').onclick = () => {
  if (!state.zones.length) return;
  state.zones.pop();
  state.selected = state.zones.at(-1)?.id ?? null;
  changed();
};
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    state.zones = state.zones.filter((z) => z.id !== state.selected);
    state.selected = null; changed();
  }
  if (e.key === 'z' && (e.ctrlKey || e.metaKey)) $('undo').click();
});

// ---------- 작업 데이터 ----------
const JOBS_KEY = 'steelcoat-jobs-v1';
let currentJobId = null;      // 목록에서 열었거나 저장한 작업

function buildJob() {
  const s = spec();
  const round = (v) => Math.round(v * 10) / 10;
  const approved = $('approved').checked;
  return {
    schema: 'steelcoat-job-v1',
    client: state.client || null,
    member: state.member || null,
    approved,
    approved_by: $('operator').value.trim(),
    approved_at: approved ? new Date().toISOString() : null,
    spec: specString(s),
    spec_ref: { standard: 'KS D 3502:2022', source: HBEAM_SOURCE, no: s.no, nominal: s.nominal, H: s.H, B: s.B, t1: s.t1, t2: s.t2, r: s.r, kg_m: s.kg_m },
    length_mm: state.length,
    frame: 'member_local_mm: X=길이(0=시작단), Y=폭(+좌, 웹 중심 0), Z=높이(0=하부 플랜지 아랫면)',
    // face 없는 영역 = 모든 면의 길이 구간 (기존 planner 형식과 동일).
    // face 있는 영역 = 해당 면의 사각형. from/to는 플랜지 면이면 Y, 웹 면이면 Z (mm).
    exclusion_zones: state.zones.map((z) => z.face === 'all'
      ? { start: round(z.start), end: round(z.end) }
      : { face: z.face, start: round(z.start), end: round(z.end), axis: faceById(z.face).axis, from: round(z.from), to: round(z.to) }),
  };
}
function msg(t, kind = '', el = 'msg') { const m = $(el); m.textContent = t; m.className = 'msg ' + kind; }

// 파일·목록의 작업이 KS 규격표에 맞는지 확인하고 규격 항목을 찾음
function specOf(j) {
  let s = j.spec_ref?.no && HBEAM_SPECS.find((x) => x.no === j.spec_ref.no);
  if (!s && typeof j.spec === 'string') {
    const n = j.spec.match(/[\d.]+/g)?.map(Number) || [];
    s = HBEAM_SPECS.find((x) => x.H === n[0] && x.B === n[1] && x.t1 === n[2] && x.t2 === n[3]);
  }
  if (!s) throw new Error(`${j.member || '작업'}: KS 규격표에 없는 단면`);
  if (!(j.length_mm > 0)) throw new Error(`${j.member || '작업'}: length_mm 없음`);
  return s;
}

function loadJob(j) {
  const s = specOf(j);
  state.specNo = s.no;
  state.length = clamp(Math.round(j.length_mm), 500, 30000);
  state.member = j.member || '';
  state.client = j.client || '';
  state.zones = (j.exclusion_zones || []).map((z) => ({
    id: nextId++, face: z.face || 'all', start: z.start, end: z.end,
    ...(z.face ? { from: z.from, to: z.to } : {}),
  }));
  state.selected = null;
  $('operator').value = j.approved_by || $('operator').value;
  $('approved').checked = j.approved === true;
  syncInputs();
  specChanged(true);
}

// ---------- 저장 목록 (이 기기) ----------
function readJobs() {
  try { return JSON.parse(localStorage.getItem(JOBS_KEY) || '[]'); } catch { return []; }
}
function writeJobs(list) {
  try { localStorage.setItem(JOBS_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}
// 처음 실행(저장 목록이 아예 없을 때)만 예시 데이터를 넣음. 목록에서 삭제 가능.
const CLIENT_OF = { 'B-101': '가온건설', 'B-102': '가온건설', 'B-103': '가온건설', 'B-104': '누리철강', 'B-201': '누리철강', 'B-202': '누리철강', 'B-203': '다온중공업', 'C-301': '다온중공업' };
function seedSamples() {
  let raw;
  try { raw = localStorage.getItem(JOBS_KEY); } catch { return; }
  if (raw !== null) {
    // 발주사 항목이 생기기 전에 들어간 예시 데이터에 발주사를 채움 (한 번만)
    try {
      if (localStorage.getItem('steelcoat-seed-client')) return;
      const list = readJobs();
      list.forEach((r) => { if (!r.job.client && CLIENT_OF[r.job.member]) r.job.client = CLIENT_OF[r.job.member]; });
      writeJobs(list); localStorage.setItem('steelcoat-seed-client', '1');
    } catch { /* 무시 */ }
    return;
  }
  try { localStorage.setItem('steelcoat-seed-client', '1'); } catch { /* 무시 */ }
  const day = (d, h) => { const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, (d * 17) % 60, 0, 0); return t.toISOString(); };
  const mk = (member, no, len, op, approved, zones, saved, done) => {
    const sp = HBEAM_SPECS.find((x) => x.no === no);
    const f = faces(sp);
    return {
      id: newId(), saved_at: day(saved, 10), ...(done != null ? { completed_at: day(done, 16) } : {}),
      job: {
        schema: 'steelcoat-job-v1', client: CLIENT_OF[member], member, approved, approved_by: op, approved_at: approved ? day(saved, 10) : null,
        spec: specString(sp),
        spec_ref: { standard: 'KS D 3502:2022', source: HBEAM_SOURCE, no: sp.no, nominal: sp.nominal, H: sp.H, B: sp.B, t1: sp.t1, t2: sp.t2, r: sp.r, kg_m: sp.kg_m },
        length_mm: len, frame: 'member_local_mm: X=길이(0=시작단), Y=폭(+좌, 웹 중심 0), Z=높이(0=하부 플랜지 아랫면)',
        exclusion_zones: zones.map(([face, a, b2, u0, u1]) => {
          if (face === 'all') return { start: a, end: b2 };
          const ff = f.find((x) => x.id === face);
          return { face, start: a, end: b2, axis: ff.axis, from: u0 ?? ff.lo, to: u1 ?? ff.hi };
        }),
      },
    };
  };
  const ends = (L) => [['all', 0, 250], ['all', L - 250, L]];
  const list = [
    mk('B-101', 45, 6000, '홍길동', true, [...ends(6000), ['top_outer', 2900, 3100, -60, 60]], 3),
    mk('B-102', 45, 6000, '홍길동', true, [...ends(6000), ['web_left', 1500, 1700], ['web_right', 1500, 1700]], 3),
    mk('B-103', 29, 8000, '김철수', true, [...ends(8000), ['bottom_outer', 3800, 4200]], 2),
    mk('B-104', 24, 6000, '김철수', false, ends(6000), 1),
    mk('B-201', 67, 10000, '이영희', true, [...ends(10000), ['top_outer', 4900, 5100, -100, 100], ['bottom_outer', 4900, 5100]], 1),
    mk('B-202', 72, 12000, '이영희', true, ends(12000), 5, 2),
    mk('B-203', 21, 6000, '박민수', true, [...ends(6000), ['web_left', 2800, 3200, 100, 150]], 6, 4),
    mk('C-301', 11, 4000, '박민수', false, [['all', 0, 150]], 0),
  ];
  writeJobs(list);
}
const norm = (v) => (v || '').trim().toLowerCase();
const sameJob = (a, b) => norm(a.client) === norm(b.client) && norm(a.member) === norm(b.member);   // 발주사 + 부재 번호
const jobLabel = (j) => `${j.client ? j.client + ' ' : ''}${j.member}`;
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

$('save').onclick = () => {
  if (!state.client) return msg('발주사를 입력하세요.', 'err');
  if (!state.member) return msg('부재 번호를 입력하세요.', 'err');
  if (!$('operator').value.trim()) return msg('작업자 이름을 입력하세요.', 'err');
  const bad = state.zones.find((z) => !(z.end > z.start) || (z.face !== 'all' && !(z.to > z.from)));
  if (bad) return msg(`${state.zones.indexOf(bad) + 1}번 영역의 크기가 0입니다.`, 'err');
  const list = readJobs();
  let rec = list.find((r) => r.id === currentJobId);
  if (rec && !sameJob(rec.job, state)) rec = null;       // 발주사·부재 번호를 바꾸면 새 항목
  if (!rec) {
    const dup = list.find((r) => sameJob(r.job, state));
    if (dup) {
      if (!confirm(`${jobLabel(state)}이(가) 목록에 이미 있습니다. 덮어쓸까요?`)) return;
      rec = dup;
    }
  }
  const prev = rec && rec.job.approved ? rec.job.approved_at : null;
  const job = buildJob();
  if (job.approved && prev) job.approved_at = prev;                       // 승인 시각 유지
  if (rec) { rec.job = job; rec.saved_at = new Date().toISOString(); }
  else { rec = { id: newId(), saved_at: new Date().toISOString(), job }; list.push(rec); }
  if (!writeJobs(list)) return msg('저장 공간이 부족해 저장하지 못했습니다.', 'err');
  currentJobId = rec.id;
  saveDraft(); renderJobs(); showEditing();
  msg(`저장했습니다: ${jobLabel(state)}${job.approved ? '' : ' (미승인)'}`, 'ok');
};

$('newJob').onclick = () => {
  currentJobId = null;
  state.member = ''; state.zones = []; state.selected = null;   // 발주사는 유지 (같은 발주사 부재를 이어서 입력)
  $('approved').checked = false;
  syncInputs(); changed(); showEditing();
  $('member').focus();
};

function showEditing() {
  const rec = currentJobId && readJobs().find((r) => r.id === currentJobId);
  $('editing').innerHTML = rec ? `저장된 작업 편집 중: <b>${esc(jobLabel(rec.job))}</b>` : '새 작업';
}
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function hl(text, q) {
  const t = esc(text);
  if (!q) return t;
  const i = t.toLowerCase().indexOf(esc(q).toLowerCase());
  return i < 0 ? t : `${t.slice(0, i)}<mark>${t.slice(i, i + q.length)}</mark>${t.slice(i + q.length)}`;
}

const picked = new Set();
let listMode = 'todo';         // 'todo' 작업 목록 / 'done' 도장 완료 목록
const fmtDate = (iso) => { const d = new Date(iso), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}.${z(d.getMonth() + 1)}.${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const fmt = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let appliedQ = '';             // 돋보기(또는 Enter)로 적용한 검색어
function visibleJobs() {
  const q = appliedQ.toLowerCase();
  const by = $('sort').value;
  const nat = (a, b) => (a || '').localeCompare(b || '', 'ko', { numeric: true, sensitivity: 'base' });
  return readJobs()
    .filter((r) => !!r.completed_at === (listMode === 'done'))
    .filter((r) => !q || [r.job.client, r.job.member, r.job.approved_by, r.job.spec, r.job.spec_ref?.nominal]
      .some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => by === 'recent' ? (b.completed_at || b.saved_at).localeCompare(a.completed_at || a.saved_at)
      : by === 'client' ? nat(a.job.client, b.job.client) || nat(a.job.member, b.job.member)
      : by === 'operator' ? nat(a.job.approved_by, b.job.approved_by) || nat(a.job.member, b.job.member)
      : by === 'spec' ? (a.job.spec_ref?.no ?? 999) - (b.job.spec_ref?.no ?? 999) || nat(a.job.member, b.job.member)
      : nat(a.job.member, b.job.member));
}
function renderJobs() {
  const all = readJobs();
  $('listCount').textContent = all.filter((r) => !r.completed_at).length;
  $('doneCount').textContent = all.filter((r) => r.completed_at).length;
  for (const id of [...picked]) if (!all.some((r) => r.id === id)) picked.delete(id);
  const rows = visibleJobs(), q = appliedQ;
  const tb = $('jobs');
  tb.replaceChildren();
  $('dateHead').textContent = listMode === 'done' ? '완료 날짜' : '저장 날짜';
  const inMode = all.some((r) => !!r.completed_at === (listMode === 'done'));
  $('jobsEmpty').textContent = !inMode
    ? (listMode === 'done' ? '도장 완료된 H빔이 없습니다.' : '작업이 없습니다. ＋ 추가로 시작하세요.')
    : !rows.length ? '검색 결과가 없습니다.' : '';
  $('jobs').closest('.tablewrap').hidden = !rows.length;
  let prevClient;
  for (const r of rows) {
    const j = r.job;
    const tr = document.createElement('tr');
    const cls = [];
    if (r.id === currentJobId) cls.push('cur');
    if ($('sort').value === 'client' && prevClient !== undefined && norm(prevClient) !== norm(j.client)) cls.push('grp');
    prevClient = j.client;
    tr.className = cls.join(' ');
    const badge = r.completed_at ? '' : `<em class="badge ${j.approved ? 'ok' : 'no'}">${j.approved ? '승인' : '미승인'}</em>`;
    tr.innerHTML = `<td class="ck"><input type="checkbox" aria-label="${esc(j.member)} 선택"${picked.has(r.id) ? ' checked' : ''}></td>
      <td class="cli">${hl(j.client || '-', q)}</td>
      <td class="mem"><b>${hl(j.member, q)}</b>${badge}</td>
      <td>${hl(j.approved_by, q)}</td>
      <td class="spec">${hl(j.spec, q)}</td>
      <td class="date">${fmtDate(r.completed_at || r.saved_at)}</td>`;
    const ck = tr.querySelector('input');
    ck.onchange = () => { ck.checked ? picked.add(r.id) : picked.delete(r.id); syncPick(); };
    tr.querySelector('.ck').onclick = (e) => { if (e.target !== ck) { ck.checked = !ck.checked; ck.onchange(); } };
    tr.onclick = (e) => {
      if (e.target.closest('.ck')) return;
      try { loadJob(r.job); currentJobId = r.id; saveDraft(); showEditing(); screen('edit'); msg(`불러옴: ${j.member}`, 'ok'); }
      catch (err) { msg(err.message, 'err', 'listMsg'); }
    };
    tb.append(tr);
  }
  syncPick();
}
function syncPick() {
  const rows = visibleJobs();
  const n = picked.size;
  $('exportSel').disabled = $('deleteSel').disabled = $('doneSel').disabled = !n;
  $('doneSel').textContent = listMode === 'done' ? '작업 목록으로 되돌리기' : '도장 완료 처리';
  $('exportSel').textContent = n ? `선택 ${n}개 JSON 내보내기` : '선택 JSON 내보내기';
  const vis = rows.filter((r) => picked.has(r.id)).length;
  $('selAll').checked = rows.length > 0 && vis === rows.length;
  $('selAll').indeterminate = vis > 0 && vis < rows.length;
}
$('searchForm').onsubmit = (e) => { e.preventDefault(); appliedQ = $('search').value.trim(); renderJobs(); };
$('search').oninput = () => { if (!$('search').value && appliedQ) { appliedQ = ''; renderJobs(); } };   // 지우면 전체 목록
$('sort').onchange = renderJobs;
$('selAll').onchange = () => {
  const rows = visibleJobs();
  rows.forEach((r) => ($('selAll').checked ? picked.add(r.id) : picked.delete(r.id)));
  renderJobs();
};
$('deleteSel').onclick = () => {
  if (!confirm(`선택한 ${picked.size}개 작업을 목록에서 삭제할까요?`)) return;
  writeJobs(readJobs().filter((r) => !picked.has(r.id)));
  if (picked.has(currentJobId)) currentJobId = null;
  picked.clear(); renderJobs(); showEditing();
  msg('삭제했습니다.', 'ok', 'listMsg');
};

async function deliver(obj, name, el) {
  const file = new File([JSON.stringify(obj, null, 2)], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
      await navigator.share({ files: [file], title: name });
      return msg(`공유: ${name}`, 'ok', el);
    }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  msg(`내보냄: ${name}`, 'ok', el);
}
$('exportSel').onclick = () => {
  const order = visibleJobs().map((r) => r.id);
  const recs = readJobs().filter((r) => picked.has(r.id))
    .sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
  const un = recs.filter((r) => !r.job.approved).length;
  if (un && !confirm(`미승인 작업 ${un}개가 포함되어 있습니다. 미승인 작업은 경로 생성에서 거부됩니다. 계속할까요?`)) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  deliver({ schema: 'steelcoat-job-batch-v1', exported_at: new Date().toISOString(), count: recs.length, jobs: recs.map((r) => r.job) },
    `steelcoat_jobs_${stamp}_${recs.length}.json`, 'listMsg');
};

// 단일 작업 JSON 또는 묶음 JSON을 목록에 추가
$('import').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const f = $('importFile').files[0];
  $('importFile').value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const jobs = Array.isArray(d.jobs) ? d.jobs : [d];
    jobs.forEach(specOf);
    const list = readJobs();
    const dups = jobs.filter((j) => list.some((r) => sameJob(r.job, j)));
    const over = dups.length ? confirm(`같은 부재 번호 ${dups.length}개가 이미 있습니다. 덮어쓸까요? (취소 = 건너뛰기)`) : false;
    let added = 0, replaced = 0;
    for (const j of jobs) {
      const old = list.find((r) => sameJob(r.job, j));
      if (old) { if (over) { old.job = j; old.saved_at = new Date().toISOString(); replaced++; } }
      else { list.push({ id: newId(), saved_at: new Date().toISOString(), job: j }); added++; }
    }
    if (!writeJobs(list)) throw new Error('저장 공간 부족');
    renderJobs();
    msg(`가져옴: 추가 ${added}개${replaced ? `, 덮어씀 ${replaced}개` : ''}${dups.length && !over ? `, 건너뜀 ${dups.length}개` : ''}`, 'ok', 'listMsg');
  } catch (e) { msg(`가져오기 실패: ${e.message}`, 'err', 'listMsg'); }
};

$('doneSel').onclick = () => {
  const list = readJobs(), now = new Date().toISOString();
  let n = 0;
  for (const r of list) {
    if (!picked.has(r.id)) continue;
    if (listMode === 'done') delete r.completed_at; else r.completed_at = now;
    n++;
  }
  writeJobs(list); picked.clear(); renderJobs();
  msg(listMode === 'done' ? `${n}개를 작업 목록으로 되돌렸습니다.` : `${n}개를 완료 목록으로 옮겼습니다.`, 'ok', 'listMsg');
};

// 화면: 'list' 목록 / 'edit' 편집
function screen(name) {
  document.querySelector('.app').classList.toggle('listmode', name === 'list');   // 목록 화면은 3D 숨김
  if (name === 'edit') requestAnimationFrame(() => { resize(); setView('iso'); });
  $('tabEdit').hidden = name !== 'edit';
  $('tabList').hidden = name !== 'list';
  if (name === 'list') { renderJobs(); $('listMsg').textContent = ''; }
  $('tabEdit').closest('.panel').scrollTop = 0;
}
document.querySelectorAll('[data-list]').forEach((b) => (b.onclick = () => {
  listMode = b.dataset.list;
  document.querySelectorAll('[data-list]').forEach((x) => x.setAttribute('aria-selected', x === b));
  picked.clear(); $('listMsg').textContent = ''; renderJobs();
}));
$('addJob').onclick = () => { $('newJob').click(); screen('edit'); msg(''); };
$('back').onclick = () => screen('list');

// ---------- 임시 저장 ----------
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ specNo: state.specNo, length: state.length, member: state.member, client: state.client, zones: state.zones, operator: $('operator').value, approved: $('approved').checked, jobId: currentJobId }));
  } catch { /* 저장 불가 환경 */ }
}
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!d || !HBEAM_SPECS.some((s) => s.no === d.specNo)) return;
    Object.assign(state, { specNo: d.specNo, length: d.length, member: d.member || '', client: d.client || '', zones: d.zones || [] });
    nextId = Math.max(0, ...state.zones.map((z) => z.id)) + 1;
    $('operator').value = d.operator || '';
    $('approved').checked = d.approved === true;
    currentJobId = d.jobId || null;
  } catch { /* 무시 */ }
}
$('operator').oninput = saveDraft;
$('approved').onchange = saveDraft;
function syncInputs() {
  $('length').value = state.length;
  $('member').value = state.member;
  $('client').value = state.client;
  const cl = [...new Set(readJobs().map((r) => r.job.client).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  $('clientList').innerHTML = cl.map((c) => `<option value="${esc(c)}">`).join('');
}

// ---------- 시작 ----------
loadDraft();
fillNominals();
syncInputs();
applyTheme();
resize();
setMode('view');
specChanged(true);
seedSamples();
showEditing();
screen('list');

// ---------- 앱 설치 ----------
let installEvt = null;
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  $('install').hidden = false;
});
$('install').onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => {});
  installEvt = null;
  $('install').hidden = true;
};
addEventListener('appinstalled', () => { $('install').hidden = true; msg('앱으로 설치되었습니다.', 'ok'); });
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (isIOS && !standalone) $('iosHint').hidden = false;

if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
