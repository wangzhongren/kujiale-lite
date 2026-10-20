import * as THREE from '../vendor/three/three.module.js';
import {
  clamp,
  distance,
  openingVerticalParts,
  polygonForLoopKey,
  wallLength,
  wallSegmentsWithOpenings,
} from './geometry.js';
import { findFurniture, furnitureDims, materialColor } from './catalog.js';

const DEFAULT_WALL_COLOR = '#ece6db';
const WALK_EYE_HEIGHT = 1.62;
const WALK_SPEED = 2.8;

function shadeColor(color, factor) {
  try {
    const parsed = new THREE.Color(color || DEFAULT_WALL_COLOR);
    return parsed.multiplyScalar(factor).getStyle();
  } catch {
    return color || DEFAULT_WALL_COLOR;
  }
}

function mergeBoxes(boxes) {
  if (!boxes.length) return null;
  const parts = [];
  let total = 0;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);
  const euler = new THREE.Euler();

  for (const box of boxes) {
    const geometry = new THREE.BoxGeometry(
      Math.max(0.002, box.w),
      Math.max(0.002, box.h),
      Math.max(0.002, box.d),
    );
    euler.set(0, box.rotY || 0, 0);
    quaternion.setFromEuler(euler);
    position.set(box.x, box.y, box.z);
    matrix.compose(position, quaternion, scale);
    geometry.applyMatrix4(matrix);
    const nonIndexed = geometry.toNonIndexed();
    const pos = nonIndexed.getAttribute('position');
    const normal = nonIndexed.getAttribute('normal');
    parts.push({ pos: new Float32Array(pos.array), normal: new Float32Array(normal.array) });
    total += pos.array.length;
    geometry.dispose();
    nonIndexed.dispose();
  }

  const positions = new Float32Array(total);
  const normals = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    positions.set(part.pos, offset);
    normals.set(part.normal, offset);
    offset += part.pos.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

export class ThreeView {
  constructor({ container, getDoc, getCatalog = () => null, readonly = false, onModeChange = null } = {}) {
    if (!container) throw new TypeError('缺少 3D 容器');
    this.container = container;
    this.getDoc = typeof getDoc === 'function' ? getDoc : () => null;
    this.getCatalog = typeof getCatalog === 'function' ? getCatalog : () => null;
    this.readonly = Boolean(readonly);
    this.onModeChange = onModeChange;

    this.mode = 'orbit';
    this.materialCache = new Map();
    this.root = null;
    this.hasFitted = false;
    this.frame = 0;
    this.walkFrame = 0;
    this.pointers = new Map();
    this.dragState = null;
    this.pinch = null;
    this.keys = new Set();
    this.lastWalkTime = 0;
    this.disposed = false;

    this.orbit = {
      target: new THREE.Vector3(0, 1, 0),
      yaw: Math.PI / 4,
      pitch: 0.72,
      distance: 14,
    };
    this.walk = {
      position: new THREE.Vector3(0, WALK_EYE_HEIGHT, 4),
      yaw: 0,
      pitch: 0,
    };

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe9e5db);
    this.scene.fog = new THREE.Fog(0xe9e5db, 32, 120);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.05, 240);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = 'three-canvas';
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute('role', 'application');
    this.container.append(this.renderer.domElement);

    this.setupLights();
    this.setupGround();
    this.bindEvents();
    this.resize();
    this.rebuild();
  }

  setupLights() {
    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8c8579, 1.35);
    this.scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(14, 20, 10);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xfff4e5, 0.6);
    fill.position.set(-10, 8, -12);
    this.scene.add(fill);
    this.lights = [hemisphere, sun, fill];
  }

  setupGround() {
    this.groundGeometry = new THREE.PlaneGeometry(260, 260);
    this.groundMaterial = new THREE.MeshLambertMaterial({ color: 0xdad5cb });
    this.ground = new THREE.Mesh(this.groundGeometry, this.groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.015;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(60, 60, 0xbfb9ad, 0xcdc8bd);
    this.grid.position.y = -0.01;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.55;
    this.scene.add(this.grid);
  }

  bindEvents() {
    const canvas = this.renderer.domElement;
    this.bound = {
      pointerdown: (event) => this.handlePointerDown(event),
      pointermove: (event) => this.handlePointerMove(event),
      pointerup: (event) => this.handlePointerUp(event),
      pointercancel: (event) => this.handlePointerUp(event),
      wheel: (event) => this.handleWheel(event),
      contextmenu: (event) => event.preventDefault(),
      keydown: (event) => this.handleKeyDown(event),
      keyup: (event) => this.handleKeyUp(event),
      mouseMove: (event) => this.handleLockedMouse(event),
      pointerLockChange: () => this.syncAria(),
      windowResize: () => this.resize(),
      contextLost: (event) => {
        event.preventDefault();
        this.contextLost = true;
      },
      contextRestored: () => {
        this.contextLost = false;
        this.rebuild();
      },
    };

    canvas.addEventListener('pointerdown', this.bound.pointerdown);
    canvas.addEventListener('pointermove', this.bound.pointermove);
    canvas.addEventListener('pointerup', this.bound.pointerup);
    canvas.addEventListener('pointercancel', this.bound.pointercancel);
    canvas.addEventListener('wheel', this.bound.wheel, { passive: false });
    canvas.addEventListener('contextmenu', this.bound.contextmenu);
    canvas.addEventListener('webglcontextlost', this.bound.contextLost);
    canvas.addEventListener('webglcontextrestored', this.bound.contextRestored);
    window.addEventListener('keydown', this.bound.keydown);
    window.addEventListener('keyup', this.bound.keyup);
    document.addEventListener('mousemove', this.bound.mouseMove);
    document.addEventListener('pointerlockchange', this.bound.pointerLockChange);

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    } else {
      this.resizeObserver = null;
      window.addEventListener('resize', this.bound.windowResize);
    }
  }

  destroy() {
    this.disposed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.walkFrame) cancelAnimationFrame(this.walkFrame);
    this.frame = 0;
    this.walkFrame = 0;
    this.keys.clear();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.bound.windowResize) window.removeEventListener('resize', this.bound.windowResize);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('pointerdown', this.bound.pointerdown);
    canvas.removeEventListener('pointermove', this.bound.pointermove);
    canvas.removeEventListener('pointerup', this.bound.pointerup);
    canvas.removeEventListener('pointercancel', this.bound.pointercancel);
    canvas.removeEventListener('wheel', this.bound.wheel);
    canvas.removeEventListener('contextmenu', this.bound.contextmenu);
    canvas.removeEventListener('webglcontextlost', this.bound.contextLost);
    canvas.removeEventListener('webglcontextrestored', this.bound.contextRestored);
    window.removeEventListener('keydown', this.bound.keydown);
    window.removeEventListener('keyup', this.bound.keyup);
    document.removeEventListener('mousemove', this.bound.mouseMove);
    document.removeEventListener('pointerlockchange', this.bound.pointerLockChange);
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();

    this.disposeRoot();
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
    this.groundGeometry.dispose();
    this.groundMaterial.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    canvas.remove();
  }

  getDocSafe() {
    return this.getDoc() || { walls: [], openings: [], rooms: [], furniture: [], materials: {} };
  }

  materialFor(color) {
    const key = String(color || DEFAULT_WALL_COLOR);
    if (!this.materialCache.has(key)) {
      this.materialCache.set(key, new THREE.MeshLambertMaterial({ color: key }));
    }
    return this.materialCache.get(key);
  }

  disposeRoot() {
    if (!this.root) return;
    this.root.traverse((object) => {
      if (object.isMesh && object.geometry) object.geometry.dispose();
    });
    this.scene.remove(this.root);
    this.root = null;
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
  }

  rebuild() {
    if (this.disposed) return;
    this.disposeRoot();
    const doc = this.getDocSafe();
    const catalog = this.getCatalog();
    const root = new THREE.Group();
    this.root = root;

    this.buildFloors(doc, catalog, root);
    this.buildBoxes(doc, catalog, root);

    this.scene.add(root);
    if (!this.hasFitted) {
      this.fitView();
      this.hasFitted = true;
    }
    this.syncAria();
    this.requestRender();
  }

  buildFloors(doc, catalog, root) {
    for (const room of doc.rooms || []) {
      const points = polygonForLoopKey(doc.walls, room.loopKey);
      if (points.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(points[0][0] / 1000, -points[0][1] / 1000);
      for (let i = 1; i < points.length; i += 1) {
        shape.lineTo(points[i][0] / 1000, -points[i][1] / 1000);
      }
      shape.closePath();
      let geometry;
      try {
        geometry = new THREE.ShapeGeometry(shape);
      } catch {
        continue;
      }
      geometry.rotateX(-Math.PI / 2);
      const color = materialColor(catalog, doc.materials?.floor?.[room.id], '#e2dccf');
      const mesh = new THREE.Mesh(geometry, this.materialFor(color));
      mesh.position.y = 0.004;
      mesh.userData.kind = 'floor';
      root.add(mesh);
    }
  }

  buildBoxes(doc, catalog, root) {
    const groups = new Map();
    const addBox = (color, w, h, d, x, y, z, rotY = 0) => {
      const key = String(color || DEFAULT_WALL_COLOR);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ w, h, d, x, y, z, rotY });
    };

    const wallColorById = new Map();
    for (const room of doc.rooms || []) {
      const color = materialColor(catalog, doc.materials?.wall?.[room.id], DEFAULT_WALL_COLOR);
      for (const wallId of String(room.loopKey || '').split('|')) {
        if (wallId && !wallColorById.has(wallId)) wallColorById.set(wallId, color);
      }
    }

    const openingsByWall = new Map();
    for (const opening of doc.openings || []) {
      if (!openingsByWall.has(opening.wallId)) openingsByWall.set(opening.wallId, []);
      openingsByWall.get(opening.wallId).push(opening);
    }

    for (const wall of doc.walls || []) {
      const length = wallLength(wall);
      if (length <= 0) continue;
      const angle = Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const color = wallColorById.get(wall.id) || DEFAULT_WALL_COLOR;
      const thickness = Math.max(20, wall.thickness || 120) / 1000;
      const height = Math.max(100, wall.height || 2800) / 1000;
      const openings = openingsByWall.get(wall.id) || [];

      const place = (offsetMm, widthMm, y0Mm, y1Mm) => {
        const centerMm = offsetMm + widthMm / 2;
        const x = wall.a[0] / 1000 + ux * (centerMm / 1000);
        const z = wall.a[1] / 1000 + uy * (centerMm / 1000);
        const h = Math.max(0.002, (y1Mm - y0Mm) / 1000);
        addBox(
          color,
          Math.max(0.002, widthMm / 1000),
          h,
          thickness,
          x,
          (y0Mm + y1Mm) / 2000,
          z,
          -angle,
        );
      };

      for (const segment of wallSegmentsWithOpenings(wall, openings)) {
        place(segment.offset, segment.width, 0, wall.height || 2800);
      }
      for (const opening of openings) {
        for (const part of openingVerticalParts(wall, opening)) {
          place(opening.offset, opening.width, part.y0, part.y1);
        }
      }
    }

    const furniture = doc.furniture || [];
    for (const item of furniture) {
      const catalogItem = findFurniture(catalog, item.catalogId);
      const dims = furnitureDims(catalogItem);
      this.addFurnitureBoxes(
        addBox,
        item,
        catalogItem,
        dims.width / 1000,
        dims.depth / 1000,
        dims.height / 1000,
      );
    }

    for (const [color, boxes] of groups) {
      const geometry = mergeBoxes(boxes);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, this.materialFor(color));
      mesh.userData.kind = 'merged';
      root.add(mesh);
    }
  }

  addFurnitureBoxes(addBox, item, catalogItem, w, d, h, overrideColor = null) {
    const rotation = -((item.rotation || 0) * Math.PI) / 180;
    const baseColor = overrideColor || catalogItem?.color || '#b7afa1';
    const accent = shadeColor(baseColor, 0.78);
    const light = shadeColor(baseColor, 1.18);
    const dark = '#2b2f33';
    const kind = catalogItem?.kind || 'generic';
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const ox = item.x / 1000;
    const oz = item.y / 1000;

    const push = (color, bw, bh, bd, lx, ly, lz) => {
      const x = ox + lx * cos - lz * sin;
      const z = oz + lx * sin + lz * cos;
      addBox(color, bw, bh, bd, x, ly, z, rotation);
    };

    if (kind === 'sofa' || kind === 'armchair') {
      push(baseColor, w, h * 0.38, d, 0, h * 0.19, 0);
      push(accent, w, h * 0.72, d * 0.18, 0, h * 0.36, -d / 2 + d * 0.09);
      push(baseColor, w * 0.12, h * 0.55, d, -w / 2 + w * 0.06, h * 0.275, 0);
      push(baseColor, w * 0.12, h * 0.55, d, w / 2 - w * 0.06, h * 0.275, 0);
    } else if (kind === 'bed') {
      push(baseColor, w, h * 0.42, d, 0, h * 0.21, 0);
      push(light, w * 0.94, h * 0.2, d * 0.94, 0, h * 0.52, 0);
      push('#f3efe7', w * 0.32, h * 0.09, d * 0.16, -w * 0.2, h * 0.65, -d / 2 + d * 0.15);
      push('#f3efe7', w * 0.32, h * 0.09, d * 0.16, w * 0.2, h * 0.65, -d / 2 + d * 0.15);
    } else if (kind === 'table' || kind === 'coffee-table' || kind === 'dining-table' || kind === 'desk') {
      push(light, w, h * 0.1, d, 0, h * 0.95, 0);
      const leg = Math.max(0.04, Math.min(w, d) * 0.06);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          push(accent, leg, h * 0.9, leg, sx * (w / 2 - leg), h * 0.45, sz * (d / 2 - leg));
        }
      }
    } else if (kind === 'chair') {
      push(baseColor, w, h * 0.12, d, 0, h * 0.45, 0);
      push(accent, w, h * 0.55, d * 0.12, 0, h * 0.72, -d / 2 + d * 0.06);
      const leg = Math.max(0.035, Math.min(w, d) * 0.06);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          push(accent, leg, h * 0.45, leg, sx * (w / 2 - leg), h * 0.225, sz * (d / 2 - leg));
        }
      }
    } else if (kind === 'wardrobe' || kind === 'cabinet' || kind === 'shelf') {
      push(baseColor, w, h, d, 0, h / 2, 0);
      push(accent, w / 2 - 0.01, h * 0.92, 0.015, -w / 4, h / 2, d / 2 + 0.008);
      push(accent, w / 2 - 0.01, h * 0.92, 0.015, w / 4, h / 2, d / 2 + 0.008);
    } else if (kind === 'tv-stand') {
      push(baseColor, w, h * 0.55, d, 0, h * 0.275, 0);
      push(dark, w * 0.72, h * 0.42, 0.04, 0, h * 0.55 + h * 0.21, -d / 2 + 0.05);
    } else if (kind === 'plant') {
      push('#8a5a35', Math.min(w, d) * 0.55, h * 0.22, Math.min(w, d) * 0.55, 0, h * 0.11, 0);
      push('#2f6b3b', w * 0.86, h * 0.62, d * 0.86, 0, h * 0.25 + h * 0.31, 0);
      push('#3f7d49', w * 0.55, h * 0.3, d * 0.55, 0, h * 0.25 + h * 0.72, 0);
    } else if (kind === 'rug') {
      push(baseColor, w, 0.02, d, 0, 0.012, 0);
    } else if (kind === 'lamp') {
      push('#5f5a52', Math.min(w, d) * 0.5, 0.04, Math.min(w, d) * 0.5, 0, 0.02, 0);
      push('#5f5a52', 0.05, h * 0.88, 0.05, 0, h * 0.44, 0);
      push('#e8d9a8', w * 0.8, h * 0.18, d * 0.8, 0, h * 0.9, 0);
    } else {
      push(baseColor, w, h, d, 0, h / 2, 0);
    }
  }

  fitView() {
    const doc = this.getDocSafe();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const wall of doc.walls || []) {
      for (const point of [wall.a, wall.b]) {
        minX = Math.min(minX, point[0]);
        minY = Math.min(minY, point[1]);
        maxX = Math.max(maxX, point[0]);
        maxY = Math.max(maxY, point[1]);
      }
    }
    for (const item of doc.furniture || []) {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x);
      maxY = Math.max(maxY, item.y);
    }
    if (!Number.isFinite(minX)) {
      this.orbit.target.set(0, 1, 0);
      this.orbit.distance = 14;
      this.orbit.yaw = Math.PI / 4;
      this.orbit.pitch = 0.72;
    } else {
      this.orbit.target.set((minX + maxX) / 2000, 1, (minY + maxY) / 2000);
      const spanX = (maxX - minX) / 1000;
      const spanY = (maxY - minY) / 1000;
      this.orbit.distance = clamp(Math.max(spanX, spanY, 4) * 1.35 + 3.5, 6, 90);
      this.orbit.yaw = Math.PI / 4;
      this.orbit.pitch = 0.72;
    }
    this.walk.position.set(
      this.orbit.target.x,
      WALK_EYE_HEIGHT,
      this.orbit.target.z + 2.5,
    );
    this.walk.yaw = 0;
    this.walk.pitch = 0;
    this.applyCamera();
    this.requestRender();
  }

  applyCamera() {
    if (this.mode === 'walk') {
      this.camera.position.copy(this.walk.position);
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(this.walk.pitch, this.walk.yaw, 0);
    } else {
      const cp = Math.cos(this.orbit.pitch);
      const sp = Math.sin(this.orbit.pitch);
      this.camera.position.set(
        this.orbit.target.x + this.orbit.distance * cp * Math.sin(this.orbit.yaw),
        this.orbit.target.y + this.orbit.distance * sp,
        this.orbit.target.z + this.orbit.distance * cp * Math.cos(this.orbit.yaw),
      );
      this.camera.lookAt(this.orbit.target);
    }
    this.camera.updateMatrixWorld();
  }

  setMode(mode) {
    if (mode !== 'orbit' && mode !== 'walk') return;
    if (mode === this.mode) return;
    if (mode === 'walk') {
      this.walk.position.set(this.camera.position.x, WALK_EYE_HEIGHT, this.camera.position.z);
      this.walk.yaw = this.orbit.yaw;
      this.walk.pitch = -0.05;
      this.mode = 'walk';
      this.keys.clear();
      this.startWalkLoop();
    } else {
      const direction = new THREE.Vector3();
      this.camera.getWorldDirection(direction);
      const target = this.walk.position.clone().addScaledVector(direction, 5);
      target.y = Math.max(0.8, target.y);
      this.orbit.target.copy(target);
      this.orbit.yaw = this.walk.yaw;
      this.orbit.pitch = 0.5;
      this.orbit.distance = Math.max(6, this.orbit.distance);
      this.mode = 'orbit';
      this.stopWalkLoop();
      if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock?.();
      this.applyCamera();
    }
    if (typeof this.onModeChange === 'function') this.onModeChange(this.mode);
    this.syncAria();
    this.requestRender();
  }

  getMode() {
    return this.mode;
  }

  resize() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    if (this.disposed || this.contextLost) return;
    this.applyCamera();
    this.renderer.render(this.scene, this.camera);
  }

  startWalkLoop() {
    if (this.walkFrame) return;
    this.lastWalkTime = performance.now();
    const tick = (time) => {
      if (this.disposed || this.mode !== 'walk') {
        this.walkFrame = 0;
        return;
      }
      const dt = Math.min(0.05, (time - this.lastWalkTime) / 1000);
      this.lastWalkTime = time;
      this.moveWalk(dt);
      this.render();
      this.walkFrame = requestAnimationFrame(tick);
    };
    this.walkFrame = requestAnimationFrame(tick);
  }

  stopWalkLoop() {
    if (this.walkFrame) cancelAnimationFrame(this.walkFrame);
    this.walkFrame = 0;
  }

  moveWalk(dt) {
    if (!this.keys.size) return;
    const forward = new THREE.Vector3(-Math.sin(this.walk.yaw), 0, -Math.cos(this.walk.yaw));
    const right = new THREE.Vector3(Math.cos(this.walk.yaw), 0, -Math.sin(this.walk.yaw));
    const velocity = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) velocity.add(forward);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) velocity.sub(forward);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) velocity.sub(right);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) velocity.add(right);
    if (!velocity.lengthSq()) return;
    velocity.normalize().multiplyScalar(WALK_SPEED * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 1.9 : 1));
    this.walk.position.addScaledVector(velocity, dt);
    this.walk.position.x = clamp(this.walk.position.x, -120, 120);
    this.walk.position.z = clamp(this.walk.position.z, -120, 120);
    this.walk.position.y = WALK_EYE_HEIGHT;
  }

  handlePointerDown(event) {
    this.renderer.domElement.focus({ preventScroll: true });
    const rect = this.renderer.domElement.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.pointers.set(event.pointerId, point);
    this.renderer.domElement.setPointerCapture?.(event.pointerId);

    if (this.pointers.size === 2) {
      const [first, second] = Array.from(this.pointers.values());
      this.pinch = {
        distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
        orbitDistance: this.orbit.distance,
      };
      return;
    }
    if (this.pointers.size > 2) return;

    if (this.mode === 'walk') {
      this.dragState = { x: event.clientX, y: event.clientY, mode: 'look' };
      if (document.pointerLockElement !== this.renderer.domElement
        && typeof this.renderer.domElement.requestPointerLock === 'function') {
        try {
          const result = this.renderer.domElement.requestPointerLock();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {
          // 指针锁定失败时仍可用拖拽观察
        }
      }
      return;
    }

    if (event.button === 2 || (event.button === 0 && event.shiftKey)) {
      this.dragState = { x: event.clientX, y: event.clientY, mode: 'pan' };
    } else {
      this.dragState = { x: event.clientX, y: event.clientY, mode: 'orbit' };
    }
  }

  handlePointerMove(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }
    if (this.pinch && this.pointers.size >= 2) {
      const [first, second] = Array.from(this.pointers.values());
      const distanceNow = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
      this.orbit.distance = clamp(
        this.pinch.orbitDistance * (this.pinch.distance / distanceNow),
        2,
        120,
      );
      this.requestRender();
      return;
    }
    if (!this.dragState) return;
    if (this.mode === 'walk') {
      if (document.pointerLockElement === this.renderer.domElement) return;
      const dx = event.clientX - this.dragState.x;
      const dy = event.clientY - this.dragState.y;
      this.dragState.x = event.clientX;
      this.dragState.y = event.clientY;
      this.walk.yaw -= dx * 0.0045;
      this.walk.pitch = clamp(this.walk.pitch - dy * 0.0045, -1.2, 1.2);
      this.requestRender();
      return;
    }
    const dx = event.clientX - this.dragState.x;
    const dy = event.clientY - this.dragState.y;
    this.dragState.x = event.clientX;
    this.dragState.y = event.clientY;
    if (this.dragState.mode === 'orbit') {
      this.orbit.yaw -= dx * 0.006;
      this.orbit.pitch = clamp(this.orbit.pitch + dy * 0.005, 0.12, 1.46);
    } else {
      const scale = this.orbit.distance * 0.0016;
      const right = new THREE.Vector3(Math.cos(this.orbit.yaw), 0, -Math.sin(this.orbit.yaw));
      const forward = new THREE.Vector3(-Math.sin(this.orbit.yaw), 0, -Math.cos(this.orbit.yaw));
      this.orbit.target.addScaledVector(right, -dx * scale);
      this.orbit.target.addScaledVector(forward, dy * scale);
    }
    this.requestRender();
  }

  handlePointerUp(event) {
    this.pointers.delete(event.pointerId);
    this.renderer.domElement.releasePointerCapture?.(event.pointerId);
    if (this.pinch && this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.dragState = null;
  }

  handleWheel(event) {
    event.preventDefault();
    if (this.mode === 'walk') return;
    this.orbit.distance = clamp(
      this.orbit.distance * Math.exp(event.deltaY * 0.0012),
      2,
      120,
    );
    this.requestRender();
  }

  handleLockedMouse(event) {
    if (this.mode !== 'walk' || document.pointerLockElement !== this.renderer.domElement) return;
    this.walk.yaw -= (event.movementX || 0) * 0.0022;
    this.walk.pitch = clamp(this.walk.pitch - (event.movementY || 0) * 0.0022, -1.2, 1.2);
    this.requestRender();
  }

  isTypingTarget(target) {
    if (!target || !(target instanceof Element)) return false;
    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  }

  handleKeyDown(event) {
    if (this.isTypingTarget(event.target)) return;
    if (this.mode === 'walk') {
      const movementKeys = [
        'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'ShiftLeft', 'ShiftRight',
      ];
      if (movementKeys.includes(event.code)) {
        this.keys.add(event.code);
        event.preventDefault();
      }
      return;
    }
    if (event.target !== this.renderer.domElement && document.activeElement !== this.renderer.domElement) {
      return;
    }
    const rotationStep = 0.08;
    if (event.key === 'ArrowLeft') this.orbit.yaw += rotationStep;
    else if (event.key === 'ArrowRight') this.orbit.yaw -= rotationStep;
    else if (event.key === 'ArrowUp') this.orbit.pitch = clamp(this.orbit.pitch + rotationStep, 0.12, 1.46);
    else if (event.key === 'ArrowDown') this.orbit.pitch = clamp(this.orbit.pitch - rotationStep, 0.12, 1.46);
    else if (event.key === '+' || event.key === '=') this.orbit.distance = clamp(this.orbit.distance * 0.9, 2, 120);
    else if (event.key === '-') this.orbit.distance = clamp(this.orbit.distance * 1.1, 2, 120);
    else if (event.key === 'f' || event.key === 'F') this.fitView();
    else return;
    event.preventDefault();
    this.requestRender();
  }

  handleKeyUp(event) {
    this.keys.delete(event.code);
  }

  syncAria() {
    const doc = this.getDocSafe();
    const mode = this.mode === 'walk' ? '第一人称' : '轨道';
    const locked = document.pointerLockElement === this.renderer.domElement ? '，鼠标已锁定' : '';
    const label = `3D 视图（${mode}${locked}）：${doc.walls.length} 面墙，${doc.rooms.length} 个房间，${doc.furniture.length} 件家具。轨道：拖拽旋转，滚轮缩放，Shift 或右键拖拽平移；第一人称：点击画面锁定鼠标，WASD 移动。`;
    this.renderer.domElement.setAttribute('aria-label', label);
  }
}

export default ThreeView;
