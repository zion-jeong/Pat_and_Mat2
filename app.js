import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { HBEAM_SPECS, HBEAM_SOURCE } from './hbeam_specs.js';
import { createWork3D } from './work3d.js?v=15';

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
// 예시 데이터: 버전별로 한 번만, 목록에 없는 (발주사 + 부재 번호)만 추가. 목록에서 삭제 가능.
const SEED_KEY = 'steelcoat-seed-v2';
const CLIENT_OF = { 'B-101': '가온건설', 'B-102': '가온건설', 'B-103': '가온건설', 'B-104': '누리철강', 'B-201': '누리철강', 'B-202': '누리철강', 'B-203': '다온중공업', 'C-301': '다온중공업' };
function sampleJobs() {
  const now = Date.now();
  const day = (d, h, m = 0) => {
    const t = new Date(); t.setDate(t.getDate() - d); t.setHours(h, m, 0, 0);
    return (t > now ? new Date(now - (h * 7 + m) * 60000) : t).toISOString();   // 미래 시각 방지
  };
  const mk = ([client, member, no, len, op, approved, zones, saved, done], i) => {
    const sp = HBEAM_SPECS.find((x) => x.no === no);
    const f = faces(sp);
    return {
      id: newId() + i, saved_at: day(saved, 9 + (i % 8), (i * 13) % 60), ...(done != null ? { completed_at: day(done, 15 + (i % 3), (i * 7) % 60) } : {}),
      job: {
        schema: 'steelcoat-job-v1', client, member, approved, approved_by: op, approved_at: approved ? day(saved, 9 + (i % 8)) : null,
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
  const E = (L, w = 250) => [['all', 0, w], ['all', L - w, L]];        // 양 끝 볼트 체결부
  const mid = (L, face, w = 200) => [face, L / 2 - w / 2, L / 2 + w / 2];  // 가운데 이음부
  // [발주사, 부재 번호, KS 번호, 길이, 작업자, 승인, 금지 영역, 저장(며칠 전), 완료(며칠 전)]
  return [
    ['가온건설', 'B-101', 45, 6000, '홍길동', true, [...E(6000), ['top_outer', 2900, 3100, -60, 60]], 3],
    ['가온건설', 'B-102', 45, 6000, '홍길동', true, [...E(6000), ['web_left', 1500, 1700], ['web_right', 1500, 1700]], 3],
    ['가온건설', 'B-103', 29, 8000, '김철수', true, [...E(8000), mid(8000, 'bottom_outer', 400)], 2],
    ['가온건설', 'B-105', 45, 6000, '홍길동', true, E(6000), 3],
    ['가온건설', 'B-106', 50, 9000, '최지우', true, [...E(9000, 300), mid(9000, 'top_outer')], 2],
    ['가온건설', 'B-107', 50, 9000, '최지우', false, E(9000, 300), 0],
    ['가온건설', 'B-108', 29, 8000, '김철수', true, E(8000), 8, 6],
    ['가온건설', 'B-109', 29, 8000, '김철수', true, [...E(8000), mid(8000, 'web_left')], 8, 6],
    ['누리철강', 'B-104', 24, 6000, '김철수', false, E(6000), 1],
    ['누리철강', 'B-201', 67, 10000, '이영희', true, [...E(10000), ['top_outer', 4900, 5100, -100, 100], ['bottom_outer', 4900, 5100]], 1],
    ['누리철강', 'B-202', 72, 12000, '이영희', true, E(12000), 5, 2],
    ['누리철강', 'B-204', 67, 10000, '이영희', true, E(10000), 1],
    ['누리철강', 'B-205', 76, 12000, '박민수', true, [...E(12000, 300), mid(12000, 'top_outer', 300), mid(12000, 'bottom_outer', 300)], 1],
    ['누리철강', 'B-206', 76, 12000, '박민수', false, E(12000, 300), 0],
    ['누리철강', 'B-207', 63, 7000, '이영희', true, E(7000), 7, 5],
    ['다온중공업', 'B-203', 21, 6000, '박민수', true, [...E(6000), ['web_left', 2800, 3200, 100, 150]], 6, 4],
    ['다온중공업', 'C-301', 11, 4000, '박민수', false, [['all', 0, 150]], 0],
    ['다온중공업', 'C-302', 11, 4000, '최지우', true, [['all', 0, 150], ['all', 3850, 4000]], 2],
    ['다온중공업', 'C-303', 7, 3000, '최지우', true, [['all', 0, 120]], 2],
    ['다온중공업', 'C-304', 13, 5000, '홍길동', true, [...E(5000, 200), ['web_right', 1200, 1400, 60, 140]], 4, 3],
    ['다온중공업', 'C-305', 13, 5000, '홍길동', true, E(5000, 200), 4],
    ['라온플랜트', 'D-401', 84, 15000, '이영희', true, [...E(15000, 400), mid(15000, 'top_outer', 400), mid(15000, 'bottom_outer', 400)], 1],
    ['라온플랜트', 'D-402', 84, 15000, '이영희', false, E(15000, 400), 0],
    ['라온플랜트', 'D-403', 78, 14000, '박민수', true, [...E(14000, 350), ['top_inner_left', 6800, 7200], ['top_inner_right', 6800, 7200]], 1],
    ['라온플랜트', 'D-404', 47, 9000, '김철수', true, E(9000), 9, 7],
    ['라온플랜트', 'D-405', 47, 9000, '김철수', true, [...E(9000), mid(9000, 'web_left', 300)], 9, 7],
    ['라온플랜트', 'D-406', 92, 16000, '최지우', false, E(16000, 400), 0],
    ['한결엔지니어링', 'E-501', 34, 7500, '홍길동', true, E(7500), 2],
    ['한결엔지니어링', 'E-502', 34, 7500, '홍길동', true, [...E(7500), ['bottom_outer', 3500, 4000, -80, 80]], 2],
    ['한결엔지니어링', 'E-503', 17, 5500, '박민수', true, E(5500, 200), 10, 8],
  ].map(mk);
}
function seedSamples() {
  seedWorkDemo();
  try { if (localStorage.getItem(SEED_KEY)) return; } catch { return; }
  const list = readJobs();
  // 발주사 항목이 생기기 전에 들어간 예시 데이터에 발주사 채움
  list.forEach((r) => { if (!r.job.client && CLIENT_OF[r.job.member]) r.job.client = CLIENT_OF[r.job.member]; });
  for (const rec of sampleJobs()) if (!list.some((r) => sameJob(r.job, rec.job))) list.push(rec);
  if (writeJobs(list)) try { localStorage.setItem(SEED_KEY, '1'); } catch { /* 무시 */ }
}
// 작업 목록 시연용: 예시 H빔 4개를 작업 목록으로 (한 번만, 작업 목록이 비어 있을 때)
function seedWorkDemo() {
  try {
    if (localStorage.getItem('steelcoat-seed-work')) return;
    if (localStorage.getItem(SEED_KEY) === null) seedSamplesOnly();
    const list = readJobs();
    if (!list.some((r) => r.work || r.stage === 'work')) {
      const pick = [['라온플랜트', 'D-401'], ['라온플랜트', 'D-403'], ['한결엔지니어링', 'E-501'], ['한결엔지니어링', 'E-502']];
      list.forEach((r) => { if (!r.completed_at && pick.some(([c, m]) => r.job.client === c && r.job.member === m)) r.work = true; });
      writeJobs(list);
    }
    localStorage.setItem('steelcoat-seed-work', '1');
  } catch { /* 무시 */ }
}
function seedSamplesOnly() {
  const list = readJobs();
  list.forEach((r) => { if (!r.job.client && CLIENT_OF[r.job.member]) r.job.client = CLIENT_OF[r.job.member]; });
  for (const rec of sampleJobs()) if (!list.some((r) => sameJob(r.job, rec.job))) list.push(rec);
  if (writeJobs(list)) localStorage.setItem(SEED_KEY, '1');
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
  else { rec = { id: newId(), saved_at: new Date().toISOString(), stage: 'ready', job }; list.push(rec); }
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
let listMode = 'ready';        // 'ready' 준비 목록 / 'work' 작업 목록 / 'done' 완료 목록
const stageOf = (r) => (r.completed_at || r.stage === 'done' ? 'done' : 'ready');
const inWork = (r) => stageOf(r) === 'ready' && (r.work === true || r.stage === 'work');   // 준비 목록에도 남아 있음
const fmtDate = (iso) => { const d = new Date(iso), z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}.${z(d.getMonth() + 1)}.${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`; };
const fmt = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
let appliedQ = '';             // 돋보기(또는 Enter)로 적용한 검색어
const nat = (a, b) => (a || '').localeCompare(b || '', 'ko', { numeric: true, sensitivity: 'base' });
function visibleJobs() {
  const q = appliedQ.toLowerCase();
  const by = $('sort').value;
  return readJobs()
    .filter((r) => stageOf(r) === listMode)
    .filter((r) => !q || [r.job.client, r.job.member, r.job.approved_by, r.job.spec, r.job.spec_ref?.nominal]
      .some((v) => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => by === 'recent' ? (b.completed_at || b.saved_at).localeCompare(a.completed_at || a.saved_at)
      : by === 'client' ? nat(a.job.client, b.job.client) || nat(a.job.member, b.job.member)
      : by === 'operator' ? nat(a.job.approved_by, b.job.approved_by) || nat(a.job.member, b.job.member)
      : by === 'spec' ? (a.job.spec_ref?.no ?? 999) - (b.job.spec_ref?.no ?? 999) || nat(a.job.member, b.job.member)
      : nat(a.job.member, b.job.member));
}
function openInEditor(r) {
  try { loadJob(r.job); currentJobId = r.id; saveDraft(); showEditing(); screen('edit'); msg(`불러옴: ${jobLabel(r.job)}`, 'ok'); }
  catch (err) { msg(err.message, 'err', listMode === 'work' ? 'workMsg' : 'listMsg'); }
}
function renderCounts(all = readJobs()) {
  const n = (st) => all.filter((r) => stageOf(r) === st).length;
  $('listCount').textContent = n('ready');
  $('workCount').textContent = all.filter(inWork).length;
  $('doneCount').textContent = n('done');
  const ws = workStatus(all);
  $('workStatus').textContent = ws.label;
  $('workStatus').className = 'wstat ' + ws.key;
}
function renderJobs() {
  const all = readJobs();
  renderCounts(all);
  for (const id of [...picked]) if (!all.some((r) => r.id === id)) picked.delete(id);
  if (listMode === 'work') { renderWork(); return; }
  const rows = visibleJobs(), q = appliedQ;
  const tb = $('jobs');
  tb.replaceChildren();
  $('addJob').hidden = listMode !== 'ready';
  $('dateHead').textContent = listMode === 'done' ? '완료 날짜' : '저장 날짜';
  const inMode = all.some((r) => stageOf(r) === listMode);
  $('jobsEmpty').textContent = !inMode
    ? (listMode === 'done' ? '도장 완료된 H빔이 없습니다.' : '준비된 H빔이 없습니다. ＋ 추가로 시작하세요.')
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
    const badge = listMode === 'done' ? '' : `<em class="badge ${j.approved ? 'ok' : 'no'}">${j.approved ? '승인' : '미승인'}</em>`
      + (inWork(r) ? `<em class="badge work">작업 목록${r.placement ? ' · ' + r.placement.station : ''}</em>` : '');
    tr.innerHTML = `<td class="ck"><input type="checkbox" aria-label="${esc(j.member)} 선택"${picked.has(r.id) ? ' checked' : ''}></td>
      <td class="mem"><b>${hl(j.member, q)}</b>${badge}</td>
      <td>${hl(j.approved_by, q)}</td>
      <td class="spec">${hl(j.spec, q)}</td>
      <td class="cli">${hl(j.client || '-', q)}</td>
      <td class="date">${fmtDate(r.completed_at || r.saved_at)}</td>`;
    const ck = tr.querySelector('input');
    ck.onchange = () => { ck.checked ? picked.add(r.id) : picked.delete(r.id); syncPick(); };
    tr.querySelector('.ck').onclick = (e) => { if (e.target !== ck) { ck.checked = !ck.checked; ck.onchange(); } };
    tr.onclick = (e) => { if (!e.target.closest('.ck')) openInEditor(r); };
    tb.append(tr);
  }
  syncPick();
}
function syncPick() {
  const rows = visibleJobs();
  const n = picked.size;
  $('import').hidden = listMode !== 'ready';
  $('backReady').hidden = listMode !== 'done';
  $('exportSel').hidden = true;                               // (완료 목록은 '작업 목록으로 보내기'로 대체)
  $('sendWork').hidden = listMode === 'done' ? false : listMode !== 'ready';
  $('sendWork').disabled = $('backReady').disabled = $('exportSel').disabled = $('deleteSel').disabled = !n;
  const sendLabel = listMode === 'done' ? '작업 목록으로 보내기' : '작업으로 보내기';
  $('sendWork').textContent = n ? `${n}개 ${sendLabel}` : sendLabel;
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
  const run = readWork().run_ids || [];
  if (readWork().state !== 'idle' && [...picked].some((id) => run.includes(id))) return msg('작업 중인 H빔은 삭제할 수 없습니다.', 'err', 'listMsg');
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
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
$('exportSel').onclick = () => {
  const order = visibleJobs().map((r) => r.id);
  const recs = readJobs().filter((r) => picked.has(r.id))
    .sort((a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9));
  deliver({ schema: 'steelcoat-job-batch-v1', exported_at: new Date().toISOString(), count: recs.length, jobs: recs.map((r) => r.job) },
    `steelcoat_jobs_${stamp()}_${recs.length}.json`, 'listMsg');
};

// 준비 → 작업 (승인된 것만)
$('sendWork').onclick = () => {
  const list = readJobs();
  const sel = list.filter((r) => picked.has(r.id));
  const already = sel.filter(inWork).length;
  const ok = sel.filter((r) => r.job.approved && !inWork(r)), no = sel.filter((r) => !r.job.approved).length;
  if (!ok.length) return msg(already ? '이미 작업 목록에 있습니다.' : '승인된 작업만 보낼 수 있습니다. 편집 화면에서 승인 후 저장하세요.', 'err', 'listMsg');
  ok.forEach((r) => { r.work = true; r.stage = 'ready'; delete r.completed_at; delete r.placement; });   // 완료 목록에서 보내면 재작업
  writeJobs(list); picked.clear(); renderJobs();
  msg(`${ok.length}개를 작업 목록으로 보냈습니다.${no ? ` 미승인 ${no}개는 보내지 않았습니다.` : ''}${already ? ` ${already}개는 이미 작업 목록에 있습니다.` : ''}`, 'ok', 'listMsg');
};
// 완료 → 준비
$('backReady').onclick = () => {
  const list = readJobs();
  let n = 0;
  for (const r of list) if (picked.has(r.id)) { r.stage = 'ready'; r.work = false; delete r.completed_at; delete r.placement; n++; }
  writeJobs(list); picked.clear(); renderJobs();
  msg(`${n}개를 준비 목록으로 되돌렸습니다.`, 'ok', 'listMsg');
};

// 단일 작업 JSON 또는 묶음 JSON을 준비 목록에 추가
$('import').onclick = () => $('importFile').click();
$('importFile').onchange = async () => {
  const f = $('importFile').files[0];
  $('importFile').value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const jobs = (Array.isArray(d.jobs) ? d.jobs : [d]).map((x) => x.job && x.placement ? x.job : x);   // 작업 지시서도 허용
    jobs.forEach(specOf);
    const list = readJobs();
    const dups = jobs.filter((j) => list.some((r) => sameJob(r.job, j)));
    const over = dups.length ? confirm(`같은 발주사·부재 번호 ${dups.length}개가 이미 있습니다. 덮어쓸까요? (취소 = 건너뛰기)`) : false;
    let added = 0, replaced = 0;
    for (const j of jobs) {
      const old = list.find((r) => sameJob(r.job, j));
      if (old) { if (over) { old.job = j; old.saved_at = new Date().toISOString(); replaced++; } }
      else { list.push({ id: newId(), saved_at: new Date().toISOString(), stage: 'ready', job: j }); added++; }
    }
    if (!writeJobs(list)) throw new Error('저장 공간 부족');
    renderJobs();
    msg(`가져옴: 추가 ${added}개${replaced ? `, 덮어씀 ${replaced}개` : ''}${dups.length && !over ? `, 건너뜀 ${dups.length}개` : ''}`, 'ok', 'listMsg');
  } catch (e) { msg(`가져오기 실패: ${e.message}`, 'err', 'listMsg'); }
};

// ---------- 작업 목록: Gazebo 공장 받침대에 빔 배치 ----------
// coating_factory 월드 기준(m). 받침대 줄 X = -12..9 (3 m 간격), 받침 Y = -5, 2, 9, 16, 받침 윗면 z = 0.84.
const FACTORY = { x: [-20, 19], y: [-18, 34] };
const STATIONS = [-12, -9, -6, -3, 0, 3, 6, 9].map((x, i) => ({ id: `S${i + 1}`, x }));
const SADDLE_Y = [-5, 2, 9, 16];
const SUPPORT_Z = 0.84;
const LANE_Y = [-7.5, 18.5];                 // 빔이 놓일 수 있는 Y 범위
const LANE_MID = (SADDLE_Y[0] + SADDLE_Y[3]) / 2;
const WORK_KEY = 'steelcoat-work-v1';
let workSel = null;                         // 작업 목록에서 고른 레코드 id

function readWork() { try { return JSON.parse(localStorage.getItem(WORK_KEY) || 'null') || { state: 'idle', run_ids: [] }; } catch { return { state: 'idle', run_ids: [] }; } }
function writeWork(w) { try { localStorage.setItem(WORK_KEY, JSON.stringify(w)); } catch { /* 무시 */ } }
function workStatus(all = readJobs()) {
  const w = readWork(), n = all.filter(inWork).length;
  if (w.state === 'running') return { key: 'running', label: '작업중', desc: '로봇이 배치된 H빔을 도장하고 있습니다.' };
  if (w.state === 'finished') return { key: 'finished', label: '작업 완료', desc: '로봇 작업이 끝났습니다. 확인 후 작업 완료 확인을 누르세요.' };
  if (!n) return { key: 'idle', label: '작업 대기', desc: '작업 목록이 비어 있습니다. 준비 목록에서 작업으로 보내세요.' };
  return { key: 'ready', label: '작업 준비', desc: 'H빔을 받침대에 배치하고 작업 시작을 누르세요.' };
}
const lenM = (r) => r.job.length_mm / 1000;
const placedAt = (list, st) => list.find((r) => inWork(r) && r.placement?.station === st);
const clampY = (r, yc) => clamp(yc, LANE_Y[0] + lenM(r) / 2, LANE_Y[1] - lenM(r) / 2);
const saddlesUnder = (r) => SADDLE_Y.filter((y) => Math.abs(y - r.placement.yc) <= lenM(r) / 2 - 0.2).length;
function updateWork(fn) { const list = readJobs(); fn(list); writeJobs(list); renderJobs(); }

function renderWork() {
  const all = readJobs(), w = readWork();
  const jobs = all.filter(inWork)
    .sort((a, b) => (a.placement ? 0 : 1) - (b.placement ? 0 : 1)
      || (a.placement && b.placement ? a.placement.station.localeCompare(b.placement.station, 'en', { numeric: true }) : 0)
      || nat(a.job.client, b.job.client) || nat(a.job.member, b.job.member));
  if (workSel && !jobs.some((r) => r.id === workSel)) workSel = null;
  const ws = workStatus(all), lock = w.state !== 'idle';
  $('statusBox').innerHTML = `<span class="wstat ${ws.key}">${ws.label}</span><p>${ws.desc}</p>`;
  $('workEmpty').textContent = jobs.length ? '' : '작업 목록이 비어 있습니다.';
  const ul = $('workJobs');
  ul.replaceChildren();
  for (const r of jobs) {
    const j = r.job, p = r.placement, run = w.run_ids?.includes(r.id);
    const li = document.createElement('li');
    li.className = 'wjob' + (r.id === workSel ? ' sel' : '') + (run && lock ? ' run' : '') + (lock ? ' lock' : '');
    const sd = p ? saddlesUnder(r) : 0;
    li.innerHTML = `<div class="t"><b>${esc(j.member)}</b><span class="s">${esc(j.client || '')}</span>
        <span class="pos ${p ? 'on' : 'off'}">${p ? `${p.station} 배치` : '미배치'}</span></div>
      <div class="s">${esc(j.spec)} · ${lenM(r)} m${p ? ` · Y ${(p.yc - lenM(r) / 2).toFixed(1)}~${(p.yc + lenM(r) / 2).toFixed(1)} m · 받침 ${sd}개${sd < 2 ? ' ⚠' : ''}` : ''}</div>
      <div class="acts">
        ${p ? '<button type="button" data-a="flip">시작단 방향 바꾸기</button><button type="button" data-a="unplace">배치 해제</button>' : ''}
        <button type="button" data-a="edit">금지 영역 보기</button>
        <button type="button" data-a="ready" title="작업 목록에서 빼기 (준비 목록에는 남음)">제외하기</button>
      </div>`;
    li.onclick = (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'edit') return openInEditor(r);
      if (lock && a) return msg('작업 중에는 바꿀 수 없습니다.', 'err', 'workMsg');
      if (a === 'flip') return updateWork((l) => { const x = l.find((y) => y.id === r.id); x.placement.dir *= -1; });
      if (a === 'unplace') return updateWork((l) => { delete l.find((y) => y.id === r.id).placement; });
      if (a === 'ready') return updateWork((l) => { const x = l.find((y) => y.id === r.id); x.work = false; x.stage = 'ready'; delete x.placement; });
      workSel = workSel === r.id ? null : r.id;
      renderWork();
    };
    ul.append(li);
  }
  const placed = jobs.filter((r) => r.placement);
  $('startWork').hidden = w.state !== 'idle';
  $('startWork').disabled = !placed.length;
  $('startWork').textContent = placed.length ? `작업 시작 (${placed.length}개)` : '작업 시작';
  $('robotDone').hidden = $('stopWork').hidden = w.state !== 'running';
  $('confirmDone').hidden = w.state !== 'finished';
  drawPlan(jobs, w);
  if (planMode === '3d') work3d.update({
    factory: FACTORY, stations: STATIONS, saddleY: SADDLE_Y, supportZ: SUPPORT_Z, laneY: LANE_Y, laneMid: LANE_MID,
    lock, showAdd: !lock,
    beams: jobs.filter((r) => r.placement).map((r) => ({
      id: r.id, station: r.placement.station, yc: r.placement.yc, dir: r.placement.dir, L: lenM(r), member: r.job.member,
      spec: specM(r), sel: r.id === workSel, run: lock && w.run_ids?.includes(r.id),
    })),
  });
}
// 3D 배치 화면
const specM = (r) => { const s = r.job.spec_ref || {}; return { H: (s.H || 300) / 1000, B: (s.B || 200) / 1000, t1: (s.t1 || 8) / 1000, t2: (s.t2 || 12) / 1000 }; };
let planMode = (() => { try { return localStorage.getItem('steelcoat-planmode') || '3d'; } catch { return '3d'; } })();
const work3d = createWork3D({
  canvas: $('c3'),
  hShape,
  onAdd: (st) => placeAt(st),
  onSelect: (id) => { workSel = id; renderWork(); },
  onDrag: (id, yc) => {
    const list = readJobs(), r = list.find((x) => x.id === id);
    if (!r?.placement) return;
    r.placement.yc = clampY(r, Math.round(yc * 4) / 4);   // 0.25 m 단위
    writeJobs(list); workSel = id; renderWork();
  },
});
function setPlanMode(m) {
  planMode = m;
  try { localStorage.setItem('steelcoat-planmode', m); } catch { /* 무시 */ }
  document.querySelectorAll('[data-pv]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.pv === m));
  $('c3').hidden = m !== '3d';
  $('plan').toggleAttribute('hidden', m !== '2d');   // SVG는 .hidden 속성이 없어 attribute로
  $('home3d').hidden = m !== '3d';
  work3d.setActive(m === '3d' && document.querySelector('.app').classList.contains('workmode'));
  if (listMode === 'work') renderWork();
}
document.querySelectorAll('[data-pv]').forEach((b) => (b.onclick = () => setPlanMode(b.dataset.pv)));
$('home3d').onclick = () => work3d.home();
if (location.hash === '#debug') window.__w3 = work3d;

// 배치도: 화면 오른쪽 = +Y, 화면 아래 = +X(입구). 위에서 내려다본 모습(좌우 반전 없음).
const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
};
let planDrag = null;
function drawPlan(jobs, w) {
  const svg = $('plan');
  svg.replaceChildren();
  const lock = w.state !== 'idle';
  const pad = 2.5, VY = [FACTORY.y[0], 23];              // 받침대가 있는 쪽만 크게 (Y 23 m 이후 홀 안쪽은 생략)
  svg.setAttribute('viewBox', `${VY[0] - pad - 1.5} ${FACTORY.x[0] - pad} ${VY[1] - VY[0] + pad + 1.5 + 0.5} ${FACTORY.x[1] - FACTORY.x[0] + pad * 2 + 1.2}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  el('rect', { class: 'floor', x: FACTORY.y[0], y: FACTORY.x[0], width: FACTORY.y[1] - FACTORY.y[0], height: FACTORY.x[1] - FACTORY.x[0] }, svg);
  for (let y = FACTORY.y[0] + 2; y < FACTORY.y[1]; y += 2) el('line', { class: 'grid', x1: y, x2: y, y1: FACTORY.x[0], y2: FACTORY.x[1] }, svg);
  el('line', { class: 'entr', x1: -16.6, x2: FACTORY.y[1], y1: FACTORY.x[1], y2: FACTORY.x[1] }, svg);
  const t = (txt, x, y, cls = 'lbl', anchor = 'middle') => { const e = el('text', { class: cls, x, y, 'text-anchor': anchor }, svg); e.textContent = txt; return e; };
  t('입구 (+X) · 지게차 반입', 3, FACTORY.x[1] + 1.4);
  t('도료 공급대', -17.85 + 2.2, -0.5 - 1.2, 'lbl', 'start');
  el('rect', { class: 'supply', x: -17.85 - 0.6, y: -0.5 - 0.6, width: 1.2, height: 1.2, rx: 0.2 }, svg);
  el('circle', { class: 'robot', cx: -16, cy: 1.5, r: 0.7 }, svg);
  t('로봇 시작', -16, 1.5 + 1.8);
  el('circle', { class: 'worker', cx: -3, cy: 13, r: 0.45 }, svg);
  t('작업자', -3, 13 + 1.5);
  t('홀 안쪽 (+Y) →', VY[1], FACTORY.x[1] + 1.4, 'lbl', 'end');

  const sel = jobs.find((r) => r.id === workSel);
  for (const st of STATIONS) {
    const occ = placedAt(jobs, st.id);
    el('rect', { class: 'band' + (sel && !occ && !lock ? ' target' : ''), x: LANE_Y[0], y: st.x - 0.7, width: LANE_Y[1] - LANE_Y[0], height: 1.4, rx: 0.3 }, svg);
    t(st.id, LANE_Y[0] - 0.6, st.x + 0.4, 'slabel', 'end');
    for (const y of SADDLE_Y) el('rect', { class: 'saddle', x: y - 0.5, y: st.x - 0.5, width: 1, height: 1, rx: 0.1 }, svg);
    if (!occ && !lock) {
      const g = el('g', { class: 'add', role: 'button', 'aria-label': `${st.id}에 배치` }, svg);
      el('circle', { cx: LANE_MID, cy: st.x, r: 0.95 }, g);
      el('path', { d: `M${LANE_MID - 0.5} ${st.x}h1M${LANE_MID} ${st.x - 0.5}v1` }, g);
      g.addEventListener('click', () => placeAt(st.id));
    }
  }
  for (const r of jobs.filter((x) => x.placement)) {
    const p = r.placement, L = lenM(r), st = STATIONS.find((s) => s.id === p.station);
    const B = Math.max((r.job.spec_ref?.B || 200) / 1000, 0.45);
    const g = el('g', { class: 'beam' + (r.id === workSel ? ' sel' : '') + (lock ? ' lock' : '') + (lock && w.run_ids?.includes(r.id) ? ' run' : '') }, svg);
    el('rect', { class: 'body', x: p.yc - L / 2, y: st.x - B / 2, width: L, height: B, rx: 0.06 }, g);
    const sx = p.dir > 0 ? p.yc - L / 2 : p.yc + L / 2 - 0.35;               // 시작단(X=0) 표시
    el('rect', { class: 'start', x: sx, y: st.x - B / 2, width: 0.35, height: B }, g);
    const tx = el('text', { x: p.yc, y: st.x - B / 2 - 0.25, 'text-anchor': 'middle' }, g);
    tx.textContent = `${r.job.member} · ${L} m`;
    g.addEventListener('pointerdown', (e) => {
      workSel = r.id;
      if (lock) { renderWork(); return; }
      planDrag = { id: r.id, y0: svgPoint(e).x, yc0: p.yc, moved: false };
      $('plan').setPointerCapture(e.pointerId);
      e.preventDefault();
    });
  }
  if (sel?.placement) $('planHud').textContent = `${sel.job.member} · ${sel.placement.station} · 중심 Y ${sel.placement.yc.toFixed(2)} m · ${sel.placement.dir > 0 ? '+Y' : '-Y'} 방향`;
  else $('planHud').textContent = sel ? `${sel.job.member}: 놓을 받침대의 ＋를 누르세요` : (lock ? '' : '왼쪽 목록에서 H빔을 고르세요');
}
function svgPoint(e) {
  const svg = $('plan'), pt = svg.createSVGPoint();
  pt.x = e.clientX; pt.y = e.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
$('plan').addEventListener('pointermove', (e) => {
  if (!planDrag) return;
  const dy = svgPoint(e).x - planDrag.y0;
  if (Math.abs(dy) > 0.1) planDrag.moved = true;
  const list = readJobs(), r = list.find((x) => x.id === planDrag.id);
  r.placement.yc = clampY(r, Math.round((planDrag.yc0 + dy) * 4) / 4);   // 0.25 m 단위
  writeJobs(list);
  renderWork();
});
const endPlanDrag = () => { if (planDrag) { planDrag = null; renderWork(); } };
$('plan').addEventListener('pointerup', endPlanDrag);
$('plan').addEventListener('pointercancel', endPlanDrag);

function placeAt(stId) {
  if (!workSel) return msg('왼쪽 목록에서 놓을 H빔을 먼저 고르세요.', 'err', 'workMsg');
  updateWork((list) => {
    const r = list.find((x) => x.id === workSel);
    r.placement = { station: stId, yc: clampY(r, r.placement?.yc ?? LANE_MID), dir: r.placement?.dir ?? 1 };
  });
  const next = readJobs().filter((r) => inWork(r) && !r.placement)
    .sort((a, b) => nat(a.job.client, b.job.client) || nat(a.job.member, b.job.member))[0];
  workSel = next?.id ?? workSel;                                           // 다음 미배치 빔 자동 선택
  msg(`${stId}에 배치했습니다.`, 'ok', 'workMsg');
  renderWork();
}

// 작업 지시서 (Gazebo 월드 좌표). pose = 부재 좌표 원점(시작단, 웹 중심, 하부 플랜지 아랫면)의 월드 위치·방향
function workOrder(recs) {
  return {
    schema: 'steelcoat-work-order-v1',
    created_at: new Date().toISOString(),
    world: 'coating_factory_gazebo/worlds/factory_fortress.sdf',
    frame: 'gazebo_world_m: X 입구 방향, Y 홀 안쪽, Z 위. pose는 부재 좌표(X 길이, Y 폭 +좌, Z 높이) 원점의 월드 위치, yaw는 부재 X축 방향',
    support_top_z_m: SUPPORT_Z,
    count: recs.length,
    jobs: recs.map((r) => {
      const p = r.placement, L = lenM(r), st = STATIONS.find((s) => s.id === p.station);
      const y0 = p.dir > 0 ? p.yc - L / 2 : p.yc + L / 2;
      return {
        station: p.station,
        placement: { x_m: st.x, y_center_m: p.yc, y_from_m: +(p.yc - L / 2).toFixed(3), y_to_m: +(p.yc + L / 2).toFixed(3), direction: p.dir > 0 ? '+Y' : '-Y' },
        pose: { x: st.x, y: +y0.toFixed(3), z: SUPPORT_Z, yaw: p.dir > 0 ? +(Math.PI / 2).toFixed(6) : -(Math.PI / 2).toFixed(6) },
        job: r.job,
      };
    }),
  };
}
$('startWork').onclick = () => {
  const all = readJobs(), jobs = all.filter(inWork);
  const placed = jobs.filter((r) => r.placement).sort((a, b) => a.placement.station.localeCompare(b.placement.station, 'en', { numeric: true }));
  if (!placed.length) return msg('받침대에 배치된 H빔이 없습니다.', 'err', 'workMsg');
  const un = jobs.length - placed.length;
  if (un && !confirm(`배치되지 않은 ${un}개는 이번 작업에서 빠집니다. 시작할까요?`)) return;
  writeWork({ state: 'running', run_ids: placed.map((r) => r.id), started_at: new Date().toISOString() });
  renderJobs();
  deliver(workOrder(placed), `steelcoat_work_${stamp()}_${placed.length}.json`, 'workMsg');
};
$('robotDone').onclick = () => { const w = readWork(); w.state = 'finished'; w.finished_at = new Date().toISOString(); writeWork(w); renderJobs(); msg('', '', 'workMsg'); };
$('stopWork').onclick = () => {
  if (!confirm('작업을 중지하고 작업 준비 상태로 돌아갈까요?')) return;
  writeWork({ state: 'idle', run_ids: [] }); renderJobs(); msg('작업을 중지했습니다.', 'ok', 'workMsg');
};
$('confirmDone').onclick = () => {
  const w = readWork(), now = new Date().toISOString();
  let n = 0;
  updateWork((list) => list.forEach((r) => {
    if (!w.run_ids.includes(r.id)) return;
    r.stage = 'done'; r.work = false; r.completed_at = now; r.done_station = r.placement?.station; delete r.placement; n++;
  }));
  writeWork({ state: 'idle', run_ids: [] });
  renderJobs();
  msg(`${n}개를 완료 목록으로 옮겼습니다.`, 'ok', 'workMsg');
};

// 화면: 'list' 목록 / 'edit' 편집
function screen(name) {
  const app = document.querySelector('.app');
  app.classList.toggle('listmode', name === 'list' && listMode !== 'work');   // 준비·완료 목록은 패널만
  app.classList.toggle('workmode', name === 'list' && listMode === 'work');   // 작업 목록은 패널 + 배치도
  if (name === 'edit') requestAnimationFrame(() => { resize(); setView('iso'); });
  work3d.setActive(name === 'list' && listMode === 'work' && planMode === '3d');
  $('tabEdit').hidden = name !== 'edit';
  $('tabList').hidden = name !== 'list';
  $('listPane').hidden = listMode === 'work';
  $('workPane').hidden = listMode !== 'work';
  if (name === 'list') { renderJobs(); $('listMsg').textContent = ''; }
  $('tabEdit').closest('.panel').scrollTop = 0;
}
document.querySelectorAll('[data-list]').forEach((b) => (b.onclick = () => {
  listMode = b.dataset.list;
  document.querySelectorAll('[data-list]').forEach((x) => x.setAttribute('aria-selected', x === b));
  picked.clear(); $('listMsg').textContent = ''; $('workMsg').textContent = '';
  screen('list');
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
setPlanMode(planMode);
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
