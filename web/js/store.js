import { createHistory } from './undo.js';
import {
  DEFAULT_WALL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  MAX_COORD,
  MIN_COORD,
  clamp,
  distance,
  nextId,
  normalizeAngleDeg,
  reconcileRooms,
  wallLength,
} from './geometry.js';

export const MAX_WALLS = 400;
export const MAX_OPENINGS = 400;
export const MAX_FURNITURE = 400;
export const MAX_ROOMS = 50;
export const MAX_NAME_LENGTH = 80;

export class EditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EditError';
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizePoint(point, fallback = [0, 0]) {
  if (!Array.isArray(point) || point.length < 2) return fallback.slice();
  return [finiteNumber(point[0], fallback[0]), finiteNumber(point[1], fallback[1])];
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function createEmptyDoc() {
  return {
    schemaVersion: 1,
    units: 'mm',
    walls: [],
    openings: [],
    rooms: [],
    furniture: [],
    materials: { floor: {}, wall: {} },
  };
}

/** 容忍后端响应，只规范化渲染所需字段，未知字段原样保留。 */
export function normalizeDoc(raw) {
  if (!isObject(raw)) return createEmptyDoc();
  const walls = Array.isArray(raw.walls) ? raw.walls.filter(isObject).map((wall) => ({
    ...wall,
    id: String(wall.id ?? ''),
    a: normalizePoint(wall.a),
    b: normalizePoint(wall.b),
    thickness: finiteNumber(wall.thickness, DEFAULT_WALL_THICKNESS),
    height: finiteNumber(wall.height, DEFAULT_WALL_HEIGHT),
  })) : [];

  const openings = Array.isArray(raw.openings) ? raw.openings.filter(isObject).map((opening) => ({
    ...opening,
    id: String(opening.id ?? ''),
    wallId: String(opening.wallId ?? ''),
    type: opening.type === 'window' ? 'window' : 'door',
    offset: Math.max(0, finiteNumber(opening.offset, 0)),
    width: Math.max(0, finiteNumber(opening.width, 0)),
    height: Math.max(0, finiteNumber(opening.height, 0)),
    sill: Math.max(0, finiteNumber(opening.sill, 0)),
  })) : [];

  const rooms = Array.isArray(raw.rooms) ? raw.rooms.filter(isObject).map((room) => ({
    ...room,
    id: String(room.id ?? ''),
    name: typeof room.name === 'string' ? room.name : '',
    loopKey: typeof room.loopKey === 'string' ? room.loopKey : '',
  })) : [];

  const furniture = Array.isArray(raw.furniture) ? raw.furniture.filter(isObject).map((item) => ({
    ...item,
    id: String(item.id ?? ''),
    catalogId: String(item.catalogId ?? ''),
    x: finiteNumber(item.x, 0),
    y: finiteNumber(item.y, 0),
    rotation: normalizeAngleDeg(finiteNumber(item.rotation, 0)),
  })) : [];

  const materialsSource = isObject(raw.materials) ? raw.materials : {};
  const cleanMaterials = (source) => {
    const result = {};
    if (isObject(source)) {
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'string' && value) result[key] = value;
      }
    }
    return result;
  };

  return {
    ...raw,
    schemaVersion: finiteNumber(raw.schemaVersion, 1),
    units: typeof raw.units === 'string' ? raw.units : 'mm',
    walls,
    openings,
    rooms,
    furniture,
    materials: {
      ...materialsSource,
      floor: cleanMaterials(materialsSource.floor),
      wall: cleanMaterials(materialsSource.wall),
    },
  };
}

/** 兼容 {plan:{...}}、{plan:{...},doc}、直接 plan、直接 doc 等响应形态。 */
export function normalizePlanPayload(payload) {
  if (!isObject(payload)) return null;
  const source = isObject(payload.plan) ? payload.plan : payload;
  const docCandidate = isObject(payload.doc)
    ? payload.doc
    : (isObject(source.doc) ? source.doc : (Array.isArray(source.walls) ? source : null));
  const revisionSource = source.revision ?? payload.revision;
  return {
    plan: {
      id: source.id ?? payload.id ?? payload.planId ?? null,
      name: typeof source.name === 'string' ? source.name : '',
      revision: Number.isInteger(revisionSource) ? revisionSource : null,
      updatedAt: source.updatedAt ?? source.updated_at ?? payload.updatedAt ?? null,
      createdAt: source.createdAt ?? source.created_at ?? payload.createdAt ?? null,
    },
    doc: docCandidate ? normalizeDoc(docCandidate) : null,
    raw: payload,
  };
}

export function normalizePlanList(payload) {
  const itemsSource = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.items) ? payload.items : (Array.isArray(payload?.plans) ? payload.plans : []));
  const items = itemsSource.filter(isObject).map((item) => ({
    id: item.id ?? item.planId ?? null,
    name: typeof item.name === 'string' ? item.name : '',
    revision: Number.isInteger(item.revision) ? item.revision : null,
    updatedAt: item.updatedAt ?? item.updated_at ?? null,
    createdAt: item.createdAt ?? item.created_at ?? null,
  }));
  const total = Number.isInteger(payload?.total)
    ? payload.total
    : (Number.isInteger(payload?.totalCount) ? payload.totalCount : items.length);
  return { items, total };
}

export function validatePlanName(name) {
  const value = String(name ?? '').trim();
  if (!value) throw new EditError('方案名称不能为空');
  if (Array.from(value).length > MAX_NAME_LENGTH) {
    throw new EditError(`方案名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return value;
}

function checkName(name) {
  const value = String(name ?? '').trim();
  if (!value) throw new EditError('房间名称不能为空');
  if (Array.from(value).length > MAX_NAME_LENGTH) {
    throw new EditError(`房间名称不能超过 ${MAX_NAME_LENGTH} 个字符`);
  }
  return value;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd - 1e-6 && bStart < aEnd - 1e-6;
}

export function createStore({ doc: initialDoc, plan: initialPlan, onChange } = {}) {
  let doc = normalizeDoc(initialDoc || createEmptyDoc());
  let plan = {
    id: initialPlan?.id ?? null,
    name: typeof initialPlan?.name === 'string' ? initialPlan.name : '',
    revision: Number.isInteger(initialPlan?.revision) ? initialPlan.revision : null,
    updatedAt: initialPlan?.updatedAt ?? null,
  };

  const state = {
    dirty: false,
    saving: false,
    version: 0,
    savedVersion: 0,
    saveError: null,
    lastSavedAt: null,
  };

  const listeners = new Set();
  let suspended = false;

  const history = createHistory();
  history.subscribe(() => {
    if (!suspended) {
      state.dirty = true;
      state.version += 1;
    }
    emit('history');
  });

  function emit(type, detail) {
    if (typeof onChange === 'function') onChange(type, detail, api);
    for (const listener of Array.from(listeners)) listener(type, detail, api);
  }

  function snapshotRoomState() {
    return { rooms: clone(doc.rooms), materials: clone(doc.materials) };
  }

  function restoreRoomState(snapshot) {
    doc.rooms = clone(snapshot.rooms);
    doc.materials = clone(snapshot.materials);
  }

  function syncRoomsInPlace() {
    const result = reconcileRooms(doc);
    doc.rooms = result.rooms;
    doc.materials = result.materials;
    if (doc.rooms.length > MAX_ROOMS) {
      throw new EditError(`房间数量超过上限 ${MAX_ROOMS}`);
    }
  }

  /**
   * 改变墙体拓扑的命令：自动对账房间；失败时回滚墙体与房间，避免半保存状态。
   */
  function structuralCommand(label, apply, revert) {
    const before = snapshotRoomState();
    let after = null;
    return {
      label,
      redo() {
        try {
          apply();
          if (after) restoreRoomState(after);
          else {
            syncRoomsInPlace();
            after = snapshotRoomState();
          }
        } catch (error) {
          try {
            revert();
          } finally {
            restoreRoomState(before);
          }
          throw error;
        }
      },
      undo() {
        revert();
        restoreRoomState(before);
      },
    };
  }

  function findWall(id) {
    return doc.walls.find((wall) => wall.id === id) || null;
  }

  function findOpening(id) {
    return doc.openings.find((opening) => opening.id === id) || null;
  }

  function findFurniture(id) {
    return doc.furniture.find((item) => item.id === id) || null;
  }

  function findRoom(id) {
    return doc.rooms.find((room) => room.id === id) || null;
  }

  function ensureNoOpeningOverlap(wallId, start, end, excludeId = null) {
    for (const opening of doc.openings) {
      if (opening.wallId !== wallId || opening.id === excludeId) continue;
      if (overlaps(start, end, opening.offset, opening.offset + opening.width)) {
        throw new EditError('门窗与同墙其他开洞重叠');
      }
    }
  }

  function validateOpeningPlacement(wall, offset, width, height, sill) {
    const length = wallLength(wall);
    if (length <= 0) throw new EditError('墙长度无效');
    if (width < 100) throw new EditError('门窗宽度不能小于 100mm');
    if (width > length) throw new EditError('门窗宽度超过墙体长度');
    if (offset < -1e-6 || offset + width > length + 1e-6) {
      throw new EditError('门窗位置超出墙体范围');
    }
    if (sill < 0) throw new EditError('窗台高度不能为负');
    if (height < 100) throw new EditError('门窗高度不能小于 100mm');
    if (sill + height > wall.height + 1e-6) {
      throw new EditError('门窗高度与窗台高度之和不能超过墙高');
    }
  }

  function addWall({ a, b, thickness = DEFAULT_WALL_THICKNESS, height = DEFAULT_WALL_HEIGHT } = {}) {
    if (doc.walls.length >= MAX_WALLS) throw new EditError(`墙体数量已达上限 ${MAX_WALLS}`);
    if (!Array.isArray(a) || !Array.isArray(b)) throw new EditError('墙体端点无效');
    const start = [
      clamp(finiteNumber(a[0], NaN), MIN_COORD, MAX_COORD),
      clamp(finiteNumber(a[1], NaN), MIN_COORD, MAX_COORD),
    ];
    const end = [
      clamp(finiteNumber(b[0], NaN), MIN_COORD, MAX_COORD),
      clamp(finiteNumber(b[1], NaN), MIN_COORD, MAX_COORD),
    ];
    if (!Number.isFinite(start[0]) || !Number.isFinite(start[1])
      || !Number.isFinite(end[0]) || !Number.isFinite(end[1])) {
      throw new EditError('墙体坐标必须是有限数字');
    }
    if (distance(start, end) < 1) throw new EditError('墙体长度必须大于 0');
    const duplicate = doc.walls.some((wall) => (
      (Math.abs(wall.a[0] - start[0]) < 1 && Math.abs(wall.a[1] - start[1]) < 1
        && Math.abs(wall.b[0] - end[0]) < 1 && Math.abs(wall.b[1] - end[1]) < 1)
      || (Math.abs(wall.a[0] - end[0]) < 1 && Math.abs(wall.a[1] - end[1]) < 1
        && Math.abs(wall.b[0] - start[0]) < 1 && Math.abs(wall.b[1] - start[1]) < 1)
    ));
    if (duplicate) throw new EditError('相同位置已存在墙体');

    const wall = {
      id: nextId('w', doc.walls),
      a: start,
      b: end,
      thickness: clamp(finiteNumber(thickness, DEFAULT_WALL_THICKNESS), 10, 1000),
      height: clamp(finiteNumber(height, DEFAULT_WALL_HEIGHT), 100, 10000),
    };
    const index = doc.walls.length;
    history.push(structuralCommand(
      '添加墙体',
      () => {
        doc.walls.splice(index, 0, wall);
      },
      () => {
        doc.walls = doc.walls.filter((item) => item.id !== wall.id);
      },
    ));
    return wall.id;
  }

  function deleteWall(id) {
    const index = doc.walls.findIndex((wall) => wall.id === id);
    if (index < 0) return false;
    const wall = clone(doc.walls[index]);
    const removedOpenings = doc.openings
      .map((opening, openingIndex) => ({ opening: clone(opening), index: openingIndex }))
      .filter((entry) => entry.opening.wallId === id);

    history.push(structuralCommand(
      '删除墙体',
      () => {
        doc.walls = doc.walls.filter((item) => item.id !== id);
        doc.openings = doc.openings.filter((opening) => opening.wallId !== id);
      },
      () => {
        doc.walls.splice(Math.min(index, doc.walls.length), 0, wall);
        for (const entry of removedOpenings) {
          doc.openings.splice(Math.min(entry.index, doc.openings.length), 0, entry.opening);
        }
        removedOpenings.sort((left, right) => left.index - right.index);
      },
    ));
    return true;
  }

  function moveWall(id, a, b) {
    const wall = findWall(id);
    if (!wall) throw new EditError('墙体不存在');
    const nextA = [
      clamp(finiteNumber(a?.[0], wall.a[0]), MIN_COORD, MAX_COORD),
      clamp(finiteNumber(a?.[1], wall.a[1]), MIN_COORD, MAX_COORD),
    ];
    const nextB = [
      clamp(finiteNumber(b?.[0], wall.b[0]), MIN_COORD, MAX_COORD),
      clamp(finiteNumber(b?.[1], wall.b[1]), MIN_COORD, MAX_COORD),
    ];
    if (distance(nextA, nextB) < 1) throw new EditError('墙体长度必须大于 0');
    const nextLength = distance(nextA, nextB);
    for (const opening of doc.openings) {
      if (opening.wallId === id && opening.offset + opening.width > nextLength + 1e-6) {
        throw new EditError('墙体缩短后门窗会越界，请先删除或调整门窗');
      }
    }
    const oldA = [wall.a[0], wall.a[1]];
    const oldB = [wall.b[0], wall.b[1]];
    if (distance(oldA, nextA) < 1e-6 && distance(oldB, nextB) < 1e-6) return;

    history.push(structuralCommand(
      '移动墙体',
      () => {
        wall.a = [nextA[0], nextA[1]];
        wall.b = [nextB[0], nextB[1]];
      },
      () => {
        const target = findWall(id);
        if (target) {
          target.a = [oldA[0], oldA[1]];
          target.b = [oldB[0], oldB[1]];
        }
      },
    ));
  }

  function updateWall(id, patch = {}) {
    const wall = findWall(id);
    if (!wall) throw new EditError('墙体不存在');
    const old = { thickness: wall.thickness, height: wall.height };
    const next = {
      thickness: patch.thickness === undefined
        ? old.thickness
        : clamp(finiteNumber(patch.thickness, old.thickness), 10, 1000),
      height: patch.height === undefined
        ? old.height
        : clamp(finiteNumber(patch.height, old.height), 100, 10000),
    };
    if (next.thickness === old.thickness && next.height === old.height) return;
    for (const opening of doc.openings) {
      if (opening.wallId === id && opening.sill + opening.height > next.height + 1e-6) {
        throw new EditError('墙高降低后门窗会越界，请先调整门窗');
      }
    }
    history.push({
      label: '调整墙体',
      redo() {
        wall.thickness = next.thickness;
        wall.height = next.height;
      },
      undo() {
        wall.thickness = old.thickness;
        wall.height = old.height;
      },
    });
  }

  function addOpening({ wallId, type = 'door', centerOffset = 0, width, height, sill } = {}) {
    if (doc.openings.length >= MAX_OPENINGS) throw new EditError(`门窗数量已达上限 ${MAX_OPENINGS}`);
    const wall = findWall(wallId);
    if (!wall) throw new EditError('墙体不存在');
    const length = wallLength(wall);
    const isWindow = type === 'window';
    const finalWidth = clamp(
      finiteNumber(width, isWindow ? 1200 : 900),
      100,
      Math.max(100, length),
    );
    const finalHeight = finiteNumber(height, isWindow ? 1400 : 2100);
    const finalSill = Math.max(0, finiteNumber(sill, isWindow ? 900 : 0));
    const desiredStart = finiteNumber(centerOffset, length / 2) - finalWidth / 2;
    const offset = clamp(desiredStart, 0, Math.max(0, length - finalWidth));
    validateOpeningPlacement(wall, offset, finalWidth, finalHeight, finalSill);
    ensureNoOpeningOverlap(wall.id, offset, offset + finalWidth);

    const opening = {
      id: nextId('o', doc.openings),
      wallId: wall.id,
      type: isWindow ? 'window' : 'door',
      offset,
      width: finalWidth,
      height: finalHeight,
      sill: finalSill,
    };
    history.push({
      label: isWindow ? '添加窗' : '添加门',
      redo() {
        doc.openings.push(opening);
      },
      undo() {
        doc.openings = doc.openings.filter((item) => item.id !== opening.id);
      },
    });
    return opening.id;
  }

  function updateOpening(id, patch = {}) {
    const opening = findOpening(id);
    if (!opening) throw new EditError('门窗不存在');
    const wall = findWall(opening.wallId);
    if (!wall) throw new EditError('门窗所属墙体不存在');
    const length = wallLength(wall);
    const next = {
      offset: patch.offset === undefined ? opening.offset : finiteNumber(patch.offset, opening.offset),
      width: patch.width === undefined ? opening.width : finiteNumber(patch.width, opening.width),
      height: patch.height === undefined ? opening.height : finiteNumber(patch.height, opening.height),
      sill: patch.sill === undefined ? opening.sill : finiteNumber(patch.sill, opening.sill),
    };
    next.width = clamp(next.width, 100, Math.max(100, length));
    next.offset = clamp(next.offset, 0, Math.max(0, length - next.width));
    next.sill = Math.max(0, next.sill);
    next.height = clamp(next.height, 100, Math.max(100, wall.height - next.sill));
    if (next.sill + next.height > wall.height) {
      next.sill = Math.max(0, wall.height - next.height);
    }
    validateOpeningPlacement(wall, next.offset, next.width, next.height, next.sill);
    ensureNoOpeningOverlap(opening.wallId, next.offset, next.offset + next.width, id);

    const old = {
      offset: opening.offset,
      width: opening.width,
      height: opening.height,
      sill: opening.sill,
    };
    if (Object.keys(old).every((key) => Math.abs(old[key] - next[key]) < 1e-6)) return;
    history.push({
      label: '调整门窗',
      redo() {
        Object.assign(opening, next);
      },
      undo() {
        Object.assign(opening, old);
      },
    });
  }

  function deleteOpening(id) {
    const index = doc.openings.findIndex((opening) => opening.id === id);
    if (index < 0) return false;
    const opening = clone(doc.openings[index]);
    history.push({
      label: '删除门窗',
      redo() {
        doc.openings = doc.openings.filter((item) => item.id !== id);
      },
      undo() {
        doc.openings.splice(Math.min(index, doc.openings.length), 0, opening);
      },
    });
    return true;
  }

  function addFurniture({ catalogId, x = 0, y = 0, rotation = 0 } = {}) {
    if (!catalogId) throw new EditError('缺少家具目录 id');
    if (doc.furniture.length >= MAX_FURNITURE) throw new EditError(`家具数量已达上限 ${MAX_FURNITURE}`);
    const item = {
      id: nextId('f', doc.furniture),
      catalogId: String(catalogId),
      x: clamp(finiteNumber(x, 0), MIN_COORD, MAX_COORD),
      y: clamp(finiteNumber(y, 0), MIN_COORD, MAX_COORD),
      rotation: normalizeAngleDeg(finiteNumber(rotation, 0)),
    };
    history.push({
      label: '放置家具',
      redo() {
        doc.furniture.push(item);
      },
      undo() {
        doc.furniture = doc.furniture.filter((entry) => entry.id !== item.id);
      },
    });
    return item.id;
  }

  function updateFurniture(id, patch = {}) {
    const item = findFurniture(id);
    if (!item) throw new EditError('家具不存在');
    const old = { x: item.x, y: item.y, rotation: item.rotation };
    const next = {
      x: patch.x === undefined ? old.x : clamp(finiteNumber(patch.x, old.x), MIN_COORD, MAX_COORD),
      y: patch.y === undefined ? old.y : clamp(finiteNumber(patch.y, old.y), MIN_COORD, MAX_COORD),
      rotation: patch.rotation === undefined
        ? old.rotation
        : normalizeAngleDeg(finiteNumber(patch.rotation, old.rotation)),
    };
    if (Math.abs(next.x - old.x) < 1e-6
      && Math.abs(next.y - old.y) < 1e-6
      && Math.abs(next.rotation - old.rotation) < 1e-6) return;
    history.push({
      label: '移动家具',
      redo() {
        Object.assign(item, next);
      },
      undo() {
        Object.assign(item, old);
      },
    });
  }

  function rotateFurniture(id, delta) {
    const item = findFurniture(id);
    if (!item) throw new EditError('家具不存在');
    const old = item.rotation;
    const next = normalizeAngleDeg(old + finiteNumber(delta, 15));
    history.push({
      label: '旋转家具',
      redo() {
        item.rotation = next;
      },
      undo() {
        item.rotation = old;
      },
    });
  }

  function deleteFurniture(id) {
    const index = doc.furniture.findIndex((item) => item.id === id);
    if (index < 0) return false;
    const item = clone(doc.furniture[index]);
    history.push({
      label: '删除家具',
      redo() {
        doc.furniture = doc.furniture.filter((entry) => entry.id !== id);
      },
      undo() {
        doc.furniture.splice(Math.min(index, doc.furniture.length), 0, item);
      },
    });
    return true;
  }

  function setRoomName(id, name) {
    const room = findRoom(id);
    if (!room) throw new EditError('房间不存在');
    const value = checkName(name);
    if (value === room.name) return;
    const old = room.name;
    history.push({
      label: '重命名房间',
      redo() {
        room.name = value;
      },
      undo() {
        room.name = old;
      },
    });
  }

  function setMaterial(kind, roomId, materialId) {
    if (kind !== 'floor' && kind !== 'wall') throw new EditError('材质类型无效');
    const room = findRoom(roomId);
    if (!room) throw new EditError('请先选择房间');
    if (!isObject(doc.materials[kind])) doc.materials[kind] = {};
    const bucket = doc.materials[kind];
    const had = Object.prototype.hasOwnProperty.call(bucket, roomId);
    const old = had ? bucket[roomId] : null;
    const next = materialId == null ? null : String(materialId);
    if ((had ? old : null) === next) return;

    history.push({
      label: kind === 'floor' ? '设置地面材质' : '设置墙面材质',
      redo() {
        if (next == null) delete doc.materials[kind][roomId];
        else doc.materials[kind][roomId] = next;
      },
      undo() {
        if (!had) delete doc.materials[kind][roomId];
        else doc.materials[kind][roomId] = old;
      },
    });
  }

  function syncRooms() {
    const before = snapshotRoomState();
    const result = reconcileRooms(doc);
    if (result.rooms.length > MAX_ROOMS) throw new EditError(`房间数量超过上限 ${MAX_ROOMS}`);
    const after = { rooms: result.rooms, materials: result.materials };
    if (JSON.stringify(before.rooms) === JSON.stringify(after.rooms)
      && JSON.stringify(before.materials.floor) === JSON.stringify(after.materials.floor)
      && JSON.stringify(before.materials.wall) === JSON.stringify(after.materials.wall)) {
      return false;
    }
    history.push({
      label: '同步房间',
      redo() {
        restoreRoomState(after);
      },
      undo() {
        restoreRoomState(before);
      },
    });
    return true;
  }

  function setName(name) {
    const value = validatePlanName(name);
    if (value === plan.name) return;
    const old = plan.name;
    history.push({
      label: '重命名方案',
      redo() {
        plan.name = value;
      },
      undo() {
        plan.name = old;
      },
    });
  }

  function setSaving(value) {
    state.saving = Boolean(value);
    if (value) state.saveError = null;
    emit('saving');
  }

  function markSaved({ revision, name, savedVersion = state.version, savedAt = Date.now() } = {}) {
    if (Number.isInteger(revision)) plan.revision = revision;
    if (typeof name === 'string' && name) plan.name = name;
    state.savedVersion = savedVersion;
    state.version = Math.max(state.version, savedVersion);
    state.dirty = state.version !== state.savedVersion;
    state.saving = false;
    state.saveError = null;
    state.lastSavedAt = savedAt;
    emit('saved');
  }

  function setSaveError(error) {
    state.saving = false;
    state.saveError = error || null;
    emit('save-error');
  }

  function replaceDoc(nextDoc, nextPlan = {}, { dirty = false } = {}) {
    suspended = true;
    doc = normalizeDoc(nextDoc || createEmptyDoc());
    if (nextPlan.id !== undefined) plan.id = nextPlan.id;
    if (typeof nextPlan.name === 'string') plan.name = nextPlan.name;
    if (nextPlan.revision !== undefined) plan.revision = nextPlan.revision;
    if (nextPlan.updatedAt !== undefined) plan.updatedAt = nextPlan.updatedAt;
    history.clear();
    suspended = false;
    state.version = 0;
    state.savedVersion = 0;
    state.dirty = Boolean(dirty);
    state.saving = false;
    state.saveError = null;
    emit('replace');
  }

  const api = {
    getDoc() {
      return doc;
    },
    getPlan() {
      return plan;
    },
    getState() {
      return { ...state, dirty: state.dirty, canUndo: history.canUndo, canRedo: history.canRedo };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    undo() {
      return history.undo();
    },
    redo() {
      return history.redo();
    },
    get undoLabel() {
      return history.undoLabel;
    },
    get redoLabel() {
      return history.redoLabel;
    },
    addWall,
    deleteWall,
    moveWall,
    updateWall,
    addOpening,
    updateOpening,
    deleteOpening,
    addFurniture,
    updateFurniture,
    rotateFurniture,
    deleteFurniture,
    setRoomName,
    setMaterial,
    syncRooms,
    setName,
    setSaving,
    markSaved,
    setSaveError,
    replaceDoc,
  };

  return api;
}
