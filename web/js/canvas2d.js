import {
  clamp,
  distance,
  pointInPolygon,
  pointToSegment,
  polygonCentroid,
  polygonForLoopKey,
  snapAngle,
  snapPoint,
  wallLength,
  wallSegmentsWithOpenings,
} from './geometry.js';
import { findFurniture, furnitureDims, materialColor } from './catalog.js';

const GRID_MM = 100;
const SNAP_PX = 12;
const MIN_SCALE = 0.01;
const MAX_SCALE = 3;

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function sameSelection(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.id === b.id && a.endpoint === b.endpoint;
}

function shade(hex, amount) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return hex;
  let value = match[1];
  if (value.length === 3) value = value.split('').map((char) => char + char).join('');
  const number = Number.parseInt(value, 16);
  const r = clamp(((number >> 16) & 255) + amount, 0, 255);
  const g = clamp(((number >> 8) & 255) + amount, 0, 255);
  const b = clamp((number & 255) + amount, 0, 255);
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function arcPath(ctx, cx, cy, radius, start, end) {
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, end);
  ctx.stroke();
}

export class Canvas2D {
  constructor({ canvas, getDoc, getCatalog = () => null, readonly = false, handlers = {} }) {
    if (!canvas) throw new TypeError('缺少 canvas');
    this.canvas = canvas;
    this.getDoc = typeof getDoc === 'function' ? getDoc : () => null;
    this.getCatalog = typeof getCatalog === 'function' ? getCatalog : () => null;
    this.readonly = Boolean(readonly);
    this.handlers = handlers || {};
    this.ctx = canvas.getContext('2d');
    this.view = { scale: 0.08, offsetX: 0, offsetY: 0 };
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.selection = null;
    this.tool = 'select';
    this.furnitureId = null;
    this.wallStart = null;
    this.chainOrigin = null;
    this.pointerWorld = null;
    this.lastSnap = null;
    this.drag = null;
    this.pointers = new Map();
    this.pinch = null;
    this.panState = null;
    this.spacePressed = false;
    this.frame = 0;
    this.autoFit = true;
    this.hover = null;

    this.bound = {
      pointerdown: (event) => this.handlePointerDown(event),
      pointermove: (event) => this.handlePointerMove(event),
      pointerup: (event) => this.handlePointerUp(event),
      pointercancel: (event) => this.handlePointerUp(event),
      wheel: (event) => this.handleWheel(event),
      keydown: (event) => this.handleKeyDown(event),
      keyup: (event) => this.handleKeyUp(event),
      contextmenu: (event) => event.preventDefault(),
    };

    canvas.addEventListener('pointerdown', this.bound.pointerdown);
    canvas.addEventListener('pointermove', this.bound.pointermove);
    canvas.addEventListener('pointerup', this.bound.pointerup);
    canvas.addEventListener('pointercancel', this.bound.pointercancel);
    canvas.addEventListener('wheel', this.bound.wheel, { passive: false });
    canvas.addEventListener('keydown', this.bound.keydown);
    canvas.addEventListener('keyup', this.bound.keyup);
    canvas.addEventListener('contextmenu', this.bound.contextmenu);

    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    } else {
      this.resizeObserver = null;
      this.bound.windowResize = () => this.resize();
      window.addEventListener('resize', this.bound.windowResize);
    }

    this.updateCursor();
    this.resize();
  }

  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.bound.windowResize) window.removeEventListener('resize', this.bound.windowResize);
    const canvas = this.canvas;
    canvas.removeEventListener('pointerdown', this.bound.pointerdown);
    canvas.removeEventListener('pointermove', this.bound.pointermove);
    canvas.removeEventListener('pointerup', this.bound.pointerup);
    canvas.removeEventListener('pointercancel', this.bound.pointercancel);
    canvas.removeEventListener('wheel', this.bound.wheel);
    canvas.removeEventListener('keydown', this.bound.keydown);
    canvas.removeEventListener('keyup', this.bound.keyup);
    canvas.removeEventListener('contextmenu', this.bound.contextmenu);
    this.pointers.clear();
  }

  getDocSafe() {
    return this.getDoc() || { walls: [], openings: [], rooms: [], furniture: [], materials: {} };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const pixelWidth = Math.round(rect.width * this.dpr);
    const pixelHeight = Math.round(rect.height * this.dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.width = rect.width;
    this.height = rect.height;
    if (this.autoFit) {
      this.autoFit = false;
      this.fit();
    }
    this.refresh();
  }

  refresh() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  fit() {
    const doc = this.getDocSafe();
    const values = [];
    for (const wall of doc.walls || []) {
      values.push(wall.a, wall.b);
    }
    for (const item of doc.furniture || []) values.push([item.x, item.y]);

    if (!this.width || !this.height) return;
    if (!values.length) {
      this.view.scale = 0.08;
      this.view.offsetX = this.width / 2;
      this.view.offsetY = this.height / 2;
      this.refresh();
      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of values) {
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
    const padding = 56;
    const spanX = Math.max(1000, maxX - minX);
    const spanY = Math.max(1000, maxY - minY);
    const scale = clamp(
      Math.min((this.width - padding * 2) / spanX, (this.height - padding * 2) / spanY),
      MIN_SCALE,
      MAX_SCALE,
    );
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    this.view.scale = scale;
    this.view.offsetX = this.width / 2 - centerX * scale;
    this.view.offsetY = this.height / 2 - centerY * scale;
    this.refresh();
  }

  worldToScreen(point) {
    return [
      this.view.offsetX + point[0] * this.view.scale,
      this.view.offsetY + point[1] * this.view.scale,
    ];
  }

  screenToWorld(x, y) {
    return [
      (x - this.view.offsetX) / this.view.scale,
      (y - this.view.offsetY) / this.view.scale,
    ];
  }

  zoomAt(factor, screenX, screenY) {
    const nextScale = clamp(this.view.scale * factor, MIN_SCALE, MAX_SCALE);
    const [worldX, worldY] = this.screenToWorld(screenX, screenY);
    this.view.scale = nextScale;
    this.view.offsetX = screenX - worldX * nextScale;
    this.view.offsetY = screenY - worldY * nextScale;
    this.refresh();
  }

  setTool(tool, furnitureId = null) {
    if (this.readonly) return;
    const allowed = ['select', 'wall', 'door', 'window', 'furniture'];
    if (!allowed.includes(tool)) return;
    this.tool = tool;
    this.furnitureId = tool === 'furniture' ? furnitureId : null;
    this.wallStart = null;
    this.chainOrigin = null;
    this.drag = null;
    this.updateCursor();
    this.refresh();
    if (typeof this.handlers.onToolChange === 'function') this.handlers.onToolChange(this.tool);
  }

  getTool() {
    return this.tool;
  }

  select(selection, { notify = true } = {}) {
    if (this.readonly) return;
    if (sameSelection(this.selection, selection)) return;
    this.selection = selection || null;
    this.refresh();
    if (notify && typeof this.handlers.onSelect === 'function') {
      this.handlers.onSelect(this.selection);
    }
  }

  getSelection() {
    return this.selection;
  }

  setReadonly(value) {
    this.readonly = Boolean(value);
    if (this.readonly) {
      this.selection = null;
      this.tool = 'select';
      this.wallStart = null;
    }
    this.updateCursor();
    this.refresh();
  }

  updateCursor() {
    if (!this.canvas) return;
    if (this.readonly || this.spacePressed) this.canvas.style.cursor = 'grab';
    else if (this.tool === 'wall') this.canvas.style.cursor = 'crosshair';
    else if (this.tool === 'door' || this.tool === 'window') this.canvas.style.cursor = 'copy';
    else if (this.tool === 'furniture') this.canvas.style.cursor = 'copy';
    else this.canvas.style.cursor = 'default';
  }

  eventPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  endpointCandidates(excludeWallId = null) {
    const points = [];
    for (const wall of this.getDocSafe().walls || []) {
      if (wall.id === excludeWallId) continue;
      points.push(wall.a, wall.b);
    }
    if (this.chainOrigin) points.push(this.chainOrigin);
    return points;
  }

  snapForPoint(raw, { excludeWallId = null, grid = GRID_MM, thresholdPx = SNAP_PX } = {}) {
    const result = snapPoint(raw, {
      grid,
      endpoints: this.endpointCandidates(excludeWallId),
      threshold: Math.min(400, thresholdPx / this.view.scale),
    });
    return { point: [result.x, result.y], reason: result.reason };
  }

  wallPreviewEnd(raw, shiftKey = false) {
    const threshold = Math.min(400, SNAP_PX / this.view.scale);
    const candidates = this.endpointCandidates();
    let nearest = null;
    for (const endpoint of candidates) {
      const d = distance(raw, endpoint);
      if (d <= threshold && (!nearest || d < nearest.distance)) {
        nearest = { point: [endpoint[0], endpoint[1]], distance: d };
      }
    }
    if (nearest) return { point: nearest.point, reason: 'endpoint' };
    if (!this.wallStart) {
      return this.snapForPoint(raw);
    }
    const angled = snapAngle(this.wallStart, raw, { step: shiftKey ? 90 : 15 });
    return { point: [angled.x, angled.y], reason: 'angle' };
  }

  effectiveWall(wall) {
    if (this.drag && this.drag.kind === 'vertex' && this.drag.wallId === wall.id) {
      return { ...wall, a: this.drag.previewA, b: this.drag.previewB };
    }
    if (this.drag && this.drag.kind === 'wall' && this.drag.wallId === wall.id) {
      return { ...wall, a: this.drag.previewA, b: this.drag.previewB };
    }
    return wall;
  }

  effectiveOpening(opening) {
    if (this.drag && this.drag.kind === 'opening' && this.drag.openingId === opening.id) {
      return { ...opening, offset: this.drag.previewOffset };
    }
    return opening;
  }

  effectiveFurniture(item) {
    if (this.drag && this.drag.kind === 'furniture' && this.drag.furnitureId === item.id) {
      return { ...item, x: this.drag.previewX, y: this.drag.previewY };
    }
    return item;
  }

  validateSelection() {
    if (!this.selection) return;
    const doc = this.getDocSafe();
    let exists = false;
    if (this.selection.type === 'wall' || this.selection.type === 'vertex') {
      exists = (doc.walls || []).some((wall) => wall.id === this.selection.id);
    } else if (this.selection.type === 'opening') {
      exists = (doc.openings || []).some((opening) => opening.id === this.selection.id);
    } else if (this.selection.type === 'furniture') {
      exists = (doc.furniture || []).some((item) => item.id === this.selection.id);
    } else if (this.selection.type === 'room') {
      exists = (doc.rooms || []).some((room) => room.id === this.selection.id);
    }
    if (!exists) {
      this.selection = null;
      if (typeof this.handlers.onSelect === 'function') this.handlers.onSelect(null);
    }
  }

  hitTest(world) {
    const doc = this.getDocSafe();
    const tolerance = SNAP_PX / this.view.scale;

    let nearestVertex = null;
    for (const wall of doc.walls || []) {
      for (const endpoint of [0, 1]) {
        const point = endpoint === 0 ? wall.a : wall.b;
        const d = distance(world, point);
        if (d <= tolerance * 1.2 && (!nearestVertex || d < nearestVertex.distance)) {
          nearestVertex = { type: 'vertex', id: wall.id, endpoint, distance: d };
        }
      }
    }
    if (nearestVertex) return nearestVertex;

    const furniture = [...(doc.furniture || [])].reverse();
    for (const item of furniture) {
      const catalogItem = findFurniture(this.getCatalog(), item.catalogId);
      const dims = furnitureDims(catalogItem);
      const dx = world[0] - item.x;
      const dy = world[1] - item.y;
      const radians = (-(item.rotation || 0) * Math.PI) / 180;
      const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
      const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
      if (Math.abs(localX) <= dims.width / 2 + tolerance
        && Math.abs(localY) <= dims.depth / 2 + tolerance) {
        return { type: 'furniture', id: item.id };
      }
    }

    let wallHit = null;
    for (const wall of doc.walls || []) {
      const hit = pointToSegment(world, wall.a, wall.b);
      if (hit.distance <= Math.max(wall.thickness / 2, 30) + tolerance) {
        if (!wallHit || hit.distance < wallHit.distance) wallHit = { wall, hit };
      }
    }
    if (wallHit) {
      const openings = (doc.openings || []).filter((opening) => opening.wallId === wallHit.wall.id);
      const length = wallLength(wallHit.wall);
      const projection = wallHit.hit.t * length;
      for (const opening of openings) {
        if (projection >= opening.offset - tolerance && projection <= opening.offset + opening.width + tolerance) {
          return { type: 'opening', id: opening.id };
        }
      }
      return { type: 'wall', id: wallHit.wall.id };
    }

    for (const room of doc.rooms || []) {
      const points = polygonForLoopKey(doc.walls, room.loopKey);
      if (points.length >= 3 && pointInPolygon(world, points)) {
        return { type: 'room', id: room.id };
      }
    }
    return null;
  }

  handlePointerDown(event) {
    this.canvas.focus({ preventScroll: true });
    const [screenX, screenY] = this.eventPoint(event);
    this.pointers.set(event.pointerId, { x: screenX, y: screenY });
    this.canvas.setPointerCapture?.(event.pointerId);

    if (this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    if (this.pointers.size > 2) return;

    const world = this.screenToWorld(screenX, screenY);
    this.pointerWorld = world;

    if (event.button === 1 || event.button === 2 || this.spacePressed || this.readonly) {
      this.startPan(screenX, screenY);
      return;
    }

    if (this.tool === 'wall') {
      this.handleWallClick(world, event.shiftKey);
      return;
    }

    if (this.tool === 'door' || this.tool === 'window') {
      this.handleOpeningPlacement(world, this.tool);
      return;
    }

    if (this.tool === 'furniture') {
      this.handleFurniturePlacement(world);
      return;
    }

    const hit = this.hitTest(world);
    if (!hit) {
      this.select(null);
      this.startPan(screenX, screenY);
      return;
    }

    if (hit.type === 'vertex') {
      this.select({ type: 'vertex', id: hit.id, endpoint: hit.endpoint });
      const wall = (this.getDocSafe().walls || []).find((entry) => entry.id === hit.id);
      if (wall) {
        this.drag = {
          kind: 'vertex',
          wallId: wall.id,
          endpoint: hit.endpoint,
          originalA: [wall.a[0], wall.a[1]],
          originalB: [wall.b[0], wall.b[1]],
          previewA: [wall.a[0], wall.a[1]],
          previewB: [wall.b[0], wall.b[1]],
          startWorld: world,
          startScreen: [screenX, screenY],
          moved: false,
        };
        this.updateCursor();
      }
      return;
    }

    if (hit.type === 'furniture') {
      this.select({ type: 'furniture', id: hit.id });
      const item = (this.getDocSafe().furniture || []).find((entry) => entry.id === hit.id);
      if (item) {
        this.drag = {
          kind: 'furniture',
          furnitureId: item.id,
          originalX: item.x,
          originalY: item.y,
          previewX: item.x,
          previewY: item.y,
          startWorld: world,
          startScreen: [screenX, screenY],
          moved: false,
        };
      }
      return;
    }

    if (hit.type === 'opening') {
      this.select({ type: 'opening', id: hit.id });
      const opening = (this.getDocSafe().openings || []).find((entry) => entry.id === hit.id);
      if (opening) {
        this.drag = {
          kind: 'opening',
          openingId: opening.id,
          originalOffset: opening.offset,
          previewOffset: opening.offset,
          startWorld: world,
          startScreen: [screenX, screenY],
          moved: false,
        };
      }
      return;
    }

    if (hit.type === 'wall') {
      this.select({ type: 'wall', id: hit.id, endpoint: null });
      const wall = (this.getDocSafe().walls || []).find((entry) => entry.id === hit.id);
      if (wall) {
        this.drag = {
          kind: 'wall',
          wallId: wall.id,
          originalA: [wall.a[0], wall.a[1]],
          originalB: [wall.b[0], wall.b[1]],
          previewA: [wall.a[0], wall.a[1]],
          previewB: [wall.b[0], wall.b[1]],
          startWorld: world,
          startScreen: [screenX, screenY],
          moved: false,
        };
      }
      return;
    }

    if (hit.type === 'room') {
      this.select({ type: 'room', id: hit.id });
    }
  }

  startPan(screenX, screenY) {
    this.panState = { startX: screenX, startY: screenY, offsetX: this.view.offsetX, offsetY: this.view.offsetY };
    this.updateCursor();
    this.canvas.style.cursor = 'grabbing';
  }

  startPinch() {
    const points = Array.from(this.pointers.values());
    if (points.length < 2) return;
    this.drag = null;
    this.panState = null;
    const [first, second] = points;
    const centerX = (first.x + second.x) / 2;
    const centerY = (first.y + second.y) / 2;
    this.pinch = {
      distance: Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)),
      scale: this.view.scale,
      centerX,
      centerY,
      world: this.screenToWorld(centerX, centerY),
    };
  }

  handlePointerMove(event) {
    const [screenX, screenY] = this.eventPoint(event);
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: screenX, y: screenY });
    }

    if (this.pinch && this.pointers.size >= 2) {
      const points = Array.from(this.pointers.values());
      const [first, second] = points;
      const distanceNow = Math.max(1, Math.hypot(first.x - second.x, first.y - second.y));
      const centerX = (first.x + second.x) / 2;
      const centerY = (first.y + second.y) / 2;
      const nextScale = clamp(this.pinch.scale * (distanceNow / this.pinch.distance), MIN_SCALE, MAX_SCALE);
      this.view.scale = nextScale;
      this.view.offsetX = centerX - this.pinch.world[0] * nextScale;
      this.view.offsetY = centerY - this.pinch.world[1] * nextScale;
      this.refresh();
      return;
    }

    const world = this.screenToWorld(screenX, screenY);
    this.pointerWorld = world;

    if (this.panState) {
      this.view.offsetX = this.panState.offsetX + (screenX - this.panState.startX);
      this.view.offsetY = this.panState.offsetY + (screenY - this.panState.startY);
      this.refresh();
      return;
    }

    if (this.drag) {
      const dx = screenX - this.drag.startScreen[0];
      const dy = screenY - this.drag.startScreen[1];
      if (Math.hypot(dx, dy) > 3) this.drag.moved = true;
      if (!this.drag.moved) return;
      if (this.drag.kind === 'furniture') {
        const rawX = this.drag.originalX + (world[0] - this.drag.startWorld[0]);
        const rawY = this.drag.originalY + (world[1] - this.drag.startWorld[1]);
        this.drag.previewX = Math.round(rawX / 50) * 50;
        this.drag.previewY = Math.round(rawY / 50) * 50;
      } else if (this.drag.kind === 'vertex') {
        const snap = this.snapForPoint(world, { excludeWallId: this.drag.wallId });
        const point = snap.point;
        if (this.drag.endpoint === 0) {
          this.drag.previewA = point;
          this.drag.previewB = this.drag.originalB;
        } else {
          this.drag.previewA = this.drag.originalA;
          this.drag.previewB = point;
        }
        this.lastSnap = snap.reason;
      } else if (this.drag.kind === 'wall') {
        const rawDx = world[0] - this.drag.startWorld[0];
        const rawDy = world[1] - this.drag.startWorld[1];
        const snapDx = Math.round(rawDx / 50) * 50;
        const snapDy = Math.round(rawDy / 50) * 50;
        this.drag.previewA = [this.drag.originalA[0] + snapDx, this.drag.originalA[1] + snapDy];
        this.drag.previewB = [this.drag.originalB[0] + snapDx, this.drag.originalB[1] + snapDy];
      } else if (this.drag.kind === 'opening') {
        const wall = (this.getDocSafe().walls || []).find((entry) => entry.id === this.findOpeningWallId(this.drag.openingId));
        const opening = (this.getDocSafe().openings || []).find((entry) => entry.id === this.drag.openingId);
        if (wall && opening) {
          const length = wallLength(wall);
          const ux = (wall.b[0] - wall.a[0]) / (length || 1);
          const uy = (wall.b[1] - wall.a[1]) / (length || 1);
          const deltaAlong = (world[0] - this.drag.startWorld[0]) * ux
            + (world[1] - this.drag.startWorld[1]) * uy;
          const rawOffset = this.drag.originalOffset + deltaAlong;
          this.drag.previewOffset = clamp(
            Math.round(rawOffset / 10) * 10,
            0,
            Math.max(0, length - opening.width),
          );
        }
      }
      this.refresh();
      return;
    }

    if (this.tool === 'wall' && this.wallStart) {
      const preview = this.wallPreviewEnd(world, event.shiftKey);
      this.previewWallEnd = preview.point;
      this.lastSnap = preview.reason;
      this.refresh();
    } else if (this.tool === 'door' || this.tool === 'window' || this.tool === 'furniture') {
      this.hover = world;
      this.refresh();
    }
  }

  handlePointerUp(event) {
    this.pointers.delete(event.pointerId);
    this.canvas.releasePointerCapture?.(event.pointerId);
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
      return;
    }
    if (this.panState) {
      this.panState = null;
      this.updateCursor();
      return;
    }
    if (!this.drag) return;

    const drag = this.drag;
    this.drag = null;
    if (!drag.moved) {
      this.refresh();
      return;
    }

    if (drag.kind === 'furniture') {
      this.callHandler('onMoveFurniture', drag.furnitureId, { x: drag.previewX, y: drag.previewY });
    } else if (drag.kind === 'vertex') {
      const nextA = drag.endpoint === 0 ? drag.previewA : drag.originalA;
      const nextB = drag.endpoint === 1 ? drag.previewB : drag.originalB;
      this.callHandler('onMoveWall', drag.wallId, nextA, nextB);
    } else if (drag.kind === 'wall') {
      this.callHandler('onMoveWall', drag.wallId, drag.previewA, drag.previewB);
    } else if (drag.kind === 'opening') {
      this.callHandler('onMoveOpening', drag.openingId, drag.previewOffset);
    }
    this.refresh();
  }

  handleWheel(event) {
    event.preventDefault();
    const [x, y] = this.eventPoint(event);
    const factor = Math.exp(-event.deltaY * 0.0015);
    this.zoomAt(factor, x, y);
  }

  handleWallClick(world, shiftKey) {
    if (!this.wallStart) {
      const snap = this.snapForPoint(world);
      this.wallStart = snap.point;
      this.chainOrigin = snap.point;
      this.previewWallEnd = snap.point;
      this.lastSnap = snap.reason;
      this.refresh();
      return;
    }

    const preview = this.wallPreviewEnd(world, shiftKey);
    const end = preview.point;
    if (distance(this.wallStart, end) < 1) {
      this.wallStart = null;
      this.chainOrigin = null;
      this.previewWallEnd = null;
      this.refresh();
      return;
    }
    const wallId = this.callHandler('onAddWall', { a: this.wallStart, b: end });
    if (!wallId) return;
    const closed = this.chainOrigin && distance(end, this.chainOrigin) < 1;
    this.select({ type: 'wall', id: wallId });
    if (closed) {
      this.wallStart = null;
      this.chainOrigin = null;
      this.previewWallEnd = null;
    } else {
      this.wallStart = end;
      this.previewWallEnd = end;
    }
    this.refresh();
  }

  handleOpeningPlacement(world, type) {
    const doc = this.getDocSafe();
    const tolerance = SNAP_PX / this.view.scale;
    let best = null;
    for (const wall of doc.walls || []) {
      const hit = pointToSegment(world, wall.a, wall.b);
      if (hit.distance <= Math.max(wall.thickness / 2, 30) + tolerance
        && (!best || hit.distance < best.hit.distance)) {
        best = { wall, hit };
      }
    }
    if (!best) {
      this.notice('请点击墙体放置门窗');
      return;
    }
    const length = wallLength(best.wall);
    const centerOffset = best.hit.t * length;
    const openingId = this.callHandler('onAddOpening', {
      wallId: best.wall.id,
      type,
      centerOffset,
    });
    if (openingId) this.select({ type: 'opening', id: openingId });
  }

  handleFurniturePlacement(world) {
    if (!this.furnitureId) {
      this.notice('请先在右侧目录选择家具');
      return;
    }
    const snap = this.snapForPoint(world, { grid: 50 });
    const id = this.callHandler('onPlaceFurniture', {
      catalogId: this.furnitureId,
      x: snap.point[0],
      y: snap.point[1],
      rotation: 0,
    });
    if (id) this.select({ type: 'furniture', id });
  }

  findOpeningWallId(openingId) {
    const opening = (this.getDocSafe().openings || []).find((entry) => entry.id === openingId);
    return opening ? opening.wallId : null;
  }

  callHandler(name, ...args) {
    const handler = this.handlers[name];
    if (typeof handler !== 'function') return null;
    try {
      return handler(...args);
    } catch (error) {
      if (typeof this.handlers.onError === 'function') this.handlers.onError(error);
      return null;
    }
  }

  notice(message) {
    if (typeof this.handlers.onNotice === 'function') this.handlers.onNotice(message);
  }

  handleKeyDown(event) {
    if (event.key === ' ') {
      this.spacePressed = true;
      this.updateCursor();
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      this.wallStart = null;
      this.chainOrigin = null;
      this.previewWallEnd = null;
      this.select(null);
      this.setTool('select');
      event.preventDefault();
      return;
    }
    if (event.key === '+' || event.key === '=') {
      this.zoomAt(1.2, this.width / 2, this.height / 2);
      event.preventDefault();
      return;
    }
    if (event.key === '-' || event.key === '_') {
      this.zoomAt(1 / 1.2, this.width / 2, this.height / 2);
      event.preventDefault();
      return;
    }
    if (event.key === '0') {
      this.fit();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && this.wallStart) {
      this.wallStart = null;
      this.chainOrigin = null;
      this.previewWallEnd = null;
      this.refresh();
      event.preventDefault();
      return;
    }
    if (this.readonly) {
      const step = 60;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (event.key === 'ArrowLeft') this.view.offsetX += step;
        if (event.key === 'ArrowRight') this.view.offsetX -= step;
        if (event.key === 'ArrowUp') this.view.offsetY += step;
        if (event.key === 'ArrowDown') this.view.offsetY -= step;
        this.refresh();
        event.preventDefault();
      }
      return;
    }
    if (!this.selection) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.callHandler('onDelete', this.selection);
      return;
    }
    if (event.key === 'r' || event.key === 'R') {
      if (this.selection.type === 'furniture') {
        event.preventDefault();
        this.callHandler('onRotate', this.selection, event.shiftKey ? -15 : 15);
      }
      return;
    }
    const step = event.shiftKey ? 500 : 100;
    const moves = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[event.key]) {
      event.preventDefault();
      this.callHandler('onNudge', this.selection, moves[event.key][0], moves[event.key][1]);
    }
  }

  handleKeyUp(event) {
    if (event.key === ' ') {
      this.spacePressed = false;
      this.updateCursor();
    }
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.width || !this.height) return;
    const doc = this.getDocSafe();
    this.validateSelection();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = '#f2efe8';
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawGrid(ctx);
    this.drawRooms(ctx, doc);
    this.drawWalls(ctx, doc);
    this.drawOpenings(ctx, doc);
    this.drawFurniture(ctx, doc);
    this.drawWallHandles(ctx, doc);
    this.drawPreview(ctx, doc);

    const label = `2D 户型画布（${this.readonly ? '只读查看' : '可编辑'}）：${doc.walls.length} 面墙，${doc.openings.length} 个门窗，${doc.furniture.length} 件家具，${doc.rooms.length} 个房间。`;
    if (this.canvas.getAttribute('aria-label') !== label) {
      this.canvas.setAttribute('aria-label', label);
    }
  }

  drawGrid(ctx) {
    const [minX, minY] = this.screenToWorld(0, 0);
    const [maxX, maxY] = this.screenToWorld(this.width, this.height);
    const steps = [100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    let major = steps[steps.length - 1];
    for (const step of steps) {
      if (step * this.view.scale >= 26) {
        major = step;
        break;
      }
    }
    const minor = major / 5;
    if (minor * this.view.scale >= 6) {
      ctx.strokeStyle = 'rgba(120, 116, 106, 0.12)';
      ctx.lineWidth = 1;
      this.gridLines(ctx, minX, maxX, minY, maxY, minor);
    }
    ctx.strokeStyle = 'rgba(92, 88, 80, 0.22)';
    ctx.lineWidth = 1;
    this.gridLines(ctx, minX, maxX, minY, maxY, major);

    const [originX, originY] = this.worldToScreen([0, 0]);
    ctx.strokeStyle = 'rgba(20, 80, 120, 0.35)';
    ctx.lineWidth = 1.2;
    if (originX >= 0 && originX <= this.width) {
      ctx.beginPath();
      ctx.moveTo(originX, 0);
      ctx.lineTo(originX, this.height);
      ctx.stroke();
    }
    if (originY >= 0 && originY <= this.height) {
      ctx.beginPath();
      ctx.moveTo(0, originY);
      ctx.lineTo(this.width, originY);
      ctx.stroke();
    }
  }

  gridLines(ctx, minX, maxX, minY, maxY, step) {
    const startX = Math.floor(minX / step) * step;
    const startY = Math.floor(minY / step) * step;
    ctx.beginPath();
    for (let x = startX; x <= maxX; x += step) {
      const [screenX] = this.worldToScreen([x, 0]);
      const crisp = Math.round(screenX) + 0.5;
      ctx.moveTo(crisp, 0);
      ctx.lineTo(crisp, this.height);
    }
    for (let y = startY; y <= maxY; y += step) {
      const [, screenY] = this.worldToScreen([0, y]);
      const crisp = Math.round(screenY) + 0.5;
      ctx.moveTo(0, crisp);
      ctx.lineTo(this.width, crisp);
    }
    ctx.stroke();
  }

  drawRooms(ctx, doc) {
    const catalog = this.getCatalog();
    for (const room of doc.rooms || []) {
      const points = polygonForLoopKey(doc.walls, room.loopKey);
      if (points.length < 3) continue;
      const screenPoints = points.map((point) => this.worldToScreen(point));
      ctx.beginPath();
      ctx.moveTo(screenPoints[0][0], screenPoints[0][1]);
      for (let i = 1; i < screenPoints.length; i += 1) {
        ctx.lineTo(screenPoints[i][0], screenPoints[i][1]);
      }
      ctx.closePath();
      const color = materialColor(catalog, doc.materials?.floor?.[room.id], '#e6e0d3');
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
      const selected = this.selection?.type === 'room' && this.selection.id === room.id;
      ctx.strokeStyle = selected ? '#0b5cad' : 'rgba(120, 112, 98, 0.55)';
      ctx.lineWidth = selected ? 2.5 : 1;
      ctx.setLineDash(selected ? [] : [5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      const centroid = polygonCentroid(points);
      const [labelX, labelY] = this.worldToScreen(centroid);
      ctx.font = '600 13px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.strokeText(room.name || '未命名房间', labelX, labelY);
      ctx.fillStyle = '#343a40';
      ctx.fillText(room.name || '未命名房间', labelX, labelY);
    }
  }

  drawWalls(ctx, doc) {
    for (const wall of doc.walls || []) {
      const effective = this.effectiveWall(wall);
      const openings = (doc.openings || [])
        .filter((opening) => opening.wallId === wall.id)
        .map((opening) => this.effectiveOpening(opening));
      const segments = wallSegmentsWithOpenings(effective, openings);
      const length = wallLength(effective);
      if (length <= 0) continue;
      const ux = (effective.b[0] - effective.a[0]) / length;
      const uy = (effective.b[1] - effective.a[1]) / length;
      const selected = this.selection
        && (this.selection.type === 'wall' || this.selection.type === 'vertex')
        && this.selection.id === wall.id;
      const width = Math.max(3, effective.thickness * this.view.scale);

      for (const segment of segments) {
        const start = [effective.a[0] + ux * segment.offset, effective.a[1] + uy * segment.offset];
        const end = [
          effective.a[0] + ux * (segment.offset + segment.width),
          effective.a[1] + uy * (segment.offset + segment.width),
        ];
        const p0 = this.worldToScreen(start);
        const p1 = this.worldToScreen(end);

        if (selected) {
          ctx.strokeStyle = 'rgba(11, 92, 173, 0.25)';
          ctx.lineWidth = width + 7;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(p0[0], p0[1]);
          ctx.lineTo(p1[0], p1[1]);
          ctx.stroke();
        }
        ctx.strokeStyle = selected ? '#0b5cad' : '#2c3137';
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.stroke();
      }

      if (this.view.scale > 0.03) {
        const angle = Math.round((Math.atan2(effective.b[1] - effective.a[1], effective.b[0] - effective.a[0]) * 180) / Math.PI);
        const [midX, midY] = this.worldToScreen([
          (effective.a[0] + effective.b[0]) / 2,
          (effective.a[1] + effective.b[1]) / 2,
        ]);
        if (selected) {
          this.badge(ctx, `${Math.round(length)} mm · ${angle}°`, midX, midY - width / 2 - 14);
        }
      }
    }
  }

  drawOpenings(ctx, doc) {
    for (const rawOpening of doc.openings || []) {
      const opening = this.effectiveOpening(rawOpening);
      const wall = (doc.walls || []).find((entry) => entry.id === opening.wallId);
      if (!wall) continue;
      const effective = this.effectiveWall(wall);
      const length = wallLength(effective);
      if (length <= 0) continue;
      const ux = (effective.b[0] - effective.a[0]) / length;
      const uy = (effective.b[1] - effective.a[1]) / length;
      const nx = -uy;
      const ny = ux;
      const start = [effective.a[0] + ux * opening.offset, effective.a[1] + uy * opening.offset];
      const end = [
        effective.a[0] + ux * (opening.offset + opening.width),
        effective.a[1] + uy * (opening.offset + opening.width),
      ];
      const p0 = this.worldToScreen(start);
      const p1 = this.worldToScreen(end);
      const selected = this.selection?.type === 'opening' && this.selection.id === opening.id;

      if (selected) {
        ctx.strokeStyle = 'rgba(11, 92, 173, 0.45)';
        ctx.lineWidth = Math.max(6, effective.thickness * this.view.scale + 6);
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.stroke();
      }

      const thicknessPx = Math.max(6, effective.thickness * this.view.scale);
      if (opening.type === 'window') {
        const offsetPx = thicknessPx * 0.22;
        ctx.strokeStyle = selected ? '#0b5cad' : '#5e7f92';
        ctx.lineWidth = 2;
        for (const sign of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(p0[0] + nx * offsetPx * sign, p0[1] + ny * offsetPx * sign);
          ctx.lineTo(p1[0] + nx * offsetPx * sign, p1[1] + ny * offsetPx * sign);
          ctx.stroke();
        }
      } else {
        const hinge = p0;
        const radius = opening.width * this.view.scale;
        ctx.strokeStyle = selected ? '#0b5cad' : '#8a7660';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(hinge[0], hinge[1]);
        ctx.lineTo(hinge[0] + nx * radius, hinge[1] + ny * radius);
        ctx.stroke();
        const startAngle = Math.atan2(uy, ux);
        const endAngle = Math.atan2(ny, nx);
        ctx.globalAlpha = 0.7;
        arcPath(ctx, hinge[0], hinge[1], radius, startAngle, endAngle);
        ctx.globalAlpha = 1;
      }

      if (selected) {
        const [midX, midY] = this.worldToScreen([
          (start[0] + end[0]) / 2,
          (start[1] + end[1]) / 2,
        ]);
        this.badge(
          ctx,
          `${opening.type === 'window' ? '窗' : '门'} ${Math.round(opening.width)}×${Math.round(opening.height)}`,
          midX,
          midY - thicknessPx - 12,
        );
      }
    }
  }

  drawFurniture(ctx, doc) {
    const catalog = this.getCatalog();
    for (const rawItem of doc.furniture || []) {
      const item = this.effectiveFurniture(rawItem);
      const catalogItem = findFurniture(catalog, item.catalogId);
      const dims = furnitureDims(catalogItem);
      const baseColor = catalogItem?.color || '#b7afa1';
      const [screenX, screenY] = this.worldToScreen([item.x, item.y]);
      const width = Math.max(8, dims.width * this.view.scale);
      const depth = Math.max(8, dims.depth * this.view.scale);
      const selected = this.selection?.type === 'furniture' && this.selection.id === item.id;

      ctx.save();
      ctx.translate(screenX, screenY);
      ctx.rotate(((item.rotation || 0) * Math.PI) / 180);
      ctx.fillStyle = baseColor;
      ctx.globalAlpha = catalogItem?.kind === 'rug' ? 0.7 : 0.92;
      ctx.strokeStyle = '#4d4a43';
      ctx.lineWidth = 1.2;
      this.drawFurnitureShape(ctx, catalogItem?.kind || 'generic', width, depth, baseColor);
      ctx.globalAlpha = 1;
      if (selected) {
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#0b5cad';
        ctx.lineWidth = 2.5;
        ctx.strokeRect(-width / 2, -depth / 2, width, depth);
        ctx.setLineDash([]);
      }
      ctx.restore();

      if (selected) {
        this.badge(
          ctx,
          `${catalogItem?.name || item.catalogId} · ${Math.round(item.rotation || 0)}°`,
          screenX,
          screenY - depth / 2 - 14,
        );
      }
    }
  }

  drawFurnitureShape(ctx, kind, width, depth, color) {
    const left = -width / 2;
    const top = -depth / 2;
    const roundRect = (x, y, w, h, radius = 3) => {
      const r = Math.min(radius, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };

    roundRect(left, top, width, depth, Math.min(5, width / 6, depth / 6));
    ctx.fill();
    ctx.stroke();

    if (kind === 'sofa' || kind === 'armchair') {
      ctx.fillStyle = shade(color, -28);
      ctx.fillRect(left, top, width, depth * 0.24);
      ctx.fillRect(left, top, width * 0.12, depth);
      ctx.fillRect(left + width * 0.88, top, width * 0.12, depth);
    } else if (kind === 'bed') {
      ctx.fillStyle = shade(color, 32);
      ctx.fillRect(left + width * 0.08, top + depth * 0.06, width * 0.38, depth * 0.18);
      ctx.fillRect(left + width * 0.54, top + depth * 0.06, width * 0.38, depth * 0.18);
      ctx.strokeStyle = shade(color, -40);
      ctx.beginPath();
      ctx.moveTo(left, top + depth * 0.32);
      ctx.lineTo(left + width, top + depth * 0.32);
      ctx.stroke();
    } else if (kind === 'table' || kind === 'coffee-table' || kind === 'dining-table' || kind === 'desk') {
      ctx.strokeStyle = shade(color, -45);
      ctx.lineWidth = 1;
      ctx.strokeRect(left + width * 0.08, top + depth * 0.08, width * 0.84, depth * 0.84);
    } else if (kind === 'chair') {
      ctx.fillStyle = shade(color, -25);
      ctx.fillRect(left, top, width, depth * 0.2);
    } else if (kind === 'wardrobe' || kind === 'shelf' || kind === 'cabinet') {
      ctx.strokeStyle = shade(color, -45);
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i += 1) {
        const x = left + (width * i) / 3;
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, top + depth);
        ctx.stroke();
      }
    } else if (kind === 'tv-stand') {
      ctx.fillStyle = '#24282c';
      ctx.fillRect(left + width * 0.12, top + depth * 0.1, width * 0.76, Math.max(3, depth * 0.12));
    } else if (kind === 'plant') {
      ctx.fillStyle = '#2f6b3b';
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(width, depth) * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#8a5a35';
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(width, depth) * 0.18, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'rug') {
      ctx.strokeStyle = shade(color, -35);
      ctx.lineWidth = 2;
      ctx.strokeRect(left + 4, top + 4, width - 8, depth - 8);
    } else if (kind === 'lamp') {
      ctx.fillStyle = '#e8d9a8';
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(width, depth) * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawWallHandles(ctx, doc) {
    if (!this.selection) return;
    if (this.selection.type !== 'wall' && this.selection.type !== 'vertex') return;
    const wall = (doc.walls || []).find((entry) => entry.id === this.selection.id);
    if (!wall) return;
    const effective = this.effectiveWall(wall);
    for (const endpoint of [0, 1]) {
      const point = endpoint === 0 ? effective.a : effective.b;
      const [x, y] = this.worldToScreen(point);
      const active = this.selection.type === 'vertex' && this.selection.endpoint === endpoint;
      ctx.fillStyle = active ? '#0b5cad' : '#ffffff';
      ctx.strokeStyle = '#0b5cad';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.rect(x - 5, y - 5, 10, 10);
      ctx.fill();
      ctx.stroke();
    }
  }

  drawPreview(ctx, doc) {
    if (this.tool === 'wall' && this.wallStart && this.previewWallEnd) {
      const start = this.wallStart;
      const end = this.previewWallEnd;
      const p0 = this.worldToScreen(start);
      const p1 = this.worldToScreen(end);
      ctx.strokeStyle = '#0b5cad';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#0b5cad';
      ctx.beginPath();
      ctx.arc(p0[0], p0[1], 4, 0, Math.PI * 2);
      ctx.fill();
      const length = Math.round(distance(start, end));
      const angle = Math.round((Math.atan2(end[1] - start[1], end[0] - start[0]) * 180) / Math.PI);
      this.badge(ctx, `${length} mm · ${angle}°`, (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 - 18);
      this.snapMarker(ctx, end);
    }

    if (this.tool === 'furniture' && this.hover && this.furnitureId) {
      const catalogItem = findFurniture(this.getCatalog(), this.furnitureId);
      const dims = furnitureDims(catalogItem);
      const snap = this.snapForPoint(this.hover, { grid: 50 });
      const [x, y] = this.worldToScreen(snap.point);
      ctx.save();
      ctx.translate(x, y);
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = catalogItem?.color || '#b7afa1';
      ctx.strokeStyle = '#0b5cad';
      ctx.setLineDash([5, 4]);
      const width = Math.max(8, dims.width * this.view.scale);
      const depth = Math.max(8, dims.depth * this.view.scale);
      ctx.fillRect(-width / 2, -depth / 2, width, depth);
      ctx.strokeRect(-width / 2, -depth / 2, width, depth);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.restore();
      this.snapMarker(ctx, snap.point);
    }
  }

  snapMarker(ctx, point) {
    if (!this.lastSnap || this.lastSnap === 'none') return;
    const [x, y] = this.worldToScreen(point);
    ctx.strokeStyle = '#0b5cad';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  badge(ctx, text, x, y) {
    ctx.save();
    ctx.font = '600 11.5px "Segoe UI", "Microsoft YaHei", sans-serif';
    const width = ctx.measureText(text).width + 12;
    const height = 20;
    let left = x - width / 2;
    let top = y - height / 2;
    left = clamp(left, 4, this.width - width - 4);
    top = clamp(top, 4, this.height - height - 4);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeStyle = 'rgba(60, 66, 72, 0.35)';
    ctx.lineWidth = 1;
    const radius = 4;
    ctx.beginPath();
    ctx.moveTo(left + radius, top);
    ctx.arcTo(left + width, top, left + width, top + height, radius);
    ctx.arcTo(left + width, top + height, left, top + height, radius);
    ctx.arcTo(left, top + height, left, top, radius);
    ctx.arcTo(left, top, left + width, top, radius);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2c3137';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, left + 6, top + height / 2 + 0.5);
    ctx.restore();
  }
}

export default Canvas2D;
