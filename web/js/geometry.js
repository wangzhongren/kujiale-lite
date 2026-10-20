/**
 * 前端预览几何。
 * 服务端是面积、周长、材质用量与导出的唯一权威；本模块只服务 2D/3D 预览，
 * 使用与服务端相同的口径（墙中心线、鞋带公式，mm² → m² 保留 2 位）并与
 * 基准用例 4000×3000mm = 12.00 m² 对齐。
 */

export const EPSILON = 1e-6;
export const MIN_COORD = -100000;
export const MAX_COORD = 100000;
export const DEFAULT_WALL_THICKNESS = 120;
export const DEFAULT_WALL_HEIGHT = 2800;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function distanceSq(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return dx * dx + dy * dy;
}

export function distance(a, b) {
  return Math.sqrt(distanceSq(a, b));
}

export function wallLength(wall) {
  if (!wall || !Array.isArray(wall.a) || !Array.isArray(wall.b)) return 0;
  return distance(wall.a, wall.b);
}

export function wallAngleRad(wall) {
  if (!wall || !Array.isArray(wall.a) || !Array.isArray(wall.b)) return 0;
  return Math.atan2(wall.b[1] - wall.a[1], wall.b[0] - wall.a[0]);
}

export function normalizeAngleDeg(angle) {
  const wrapped = angle % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** 点到线段的最短距离；t 为投影参数（0..1）。 */
export function pointToSegment(point, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 <= EPSILON) {
    return { distance: distance(point, a), t: 0, closest: [a[0], a[1]] };
  }
  const rawT = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / len2;
  const t = clamp(rawT, 0, 1);
  const closest = [a[0] + dx * t, a[1] + dy * t];
  return { distance: distance(point, closest), t, closest };
}

/**
 * 吸附：端点优先（阈值内取最近），否则按网格四舍五入。
 * 返回新的坐标，不修改入参。
 */
export function snapPoint(point, options = {}) {
  const { grid = 100, endpoints = [], threshold = 120, snapGrid = true } = options;
  if (!Array.isArray(point) || !isFiniteNumber(point[0]) || !isFiniteNumber(point[1])) {
    return { x: 0, y: 0, snapped: false, reason: 'none' };
  }

  let best = null;
  for (const endpoint of endpoints) {
    if (!Array.isArray(endpoint) || !isFiniteNumber(endpoint[0]) || !isFiniteNumber(endpoint[1])) continue;
    const d = distance(point, endpoint);
    if (d <= threshold && (!best || d < best.distance)) {
      best = { x: endpoint[0], y: endpoint[1], distance: d };
    }
  }
  if (best) {
    return { x: best.x, y: best.y, snapped: true, reason: 'endpoint' };
  }

  if (snapGrid && isFiniteNumber(grid) && grid > 0) {
    return {
      x: Math.round(point[0] / grid) * grid,
      y: Math.round(point[1] / grid) * grid,
      snapped: true,
      reason: 'grid',
    };
  }

  return { x: point[0], y: point[1], snapped: false, reason: 'none' };
}

/** 角度吸附（默认 15°），保持长度不变。 */
export function snapAngle(anchor, point, options = {}) {
  const { step = 15 } = options;
  const dx = point[0] - anchor[0];
  const dy = point[1] - anchor[1];
  const length = Math.hypot(dx, dy);
  if (length <= EPSILON || !isFiniteNumber(step) || step <= 0) {
    return { x: point[0], y: point[1], length, angleDeg: 0, snapped: false };
  }
  const rawDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const snappedDeg = Math.round(rawDeg / step) * step;
  const angleRad = (snappedDeg * Math.PI) / 180;
  const effectiveDeg = normalizeAngleDeg(snappedDeg);
  return {
    x: anchor[0] + Math.cos(angleRad) * length,
    y: anchor[1] + Math.sin(angleRad) * length,
    length,
    angleDeg: effectiveDeg,
    snapped: true,
  };
}

/** 墙体被开洞切分后剩余的整高线段（局部 offset/width，mm）。 */
export function wallSegmentsWithOpenings(wall, openings = []) {
  const length = wallLength(wall);
  if (length <= EPSILON) return [];
  const intervals = [];
  for (const opening of openings) {
    if (!opening || opening.wallId !== wall.id) continue;
    const start = clamp(Number(opening.offset) || 0, 0, length);
    const end = clamp((Number(opening.offset) || 0) + (Number(opening.width) || 0), 0, length);
    if (end - start > EPSILON) intervals.push([start, end]);
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval[0] <= last[1] + EPSILON) {
      last[1] = Math.max(last[1], interval[1]);
    } else {
      merged.push([interval[0], interval[1]]);
    }
  }

  const segments = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start - cursor > EPSILON) segments.push({ offset: cursor, width: start - cursor });
    cursor = Math.max(cursor, end);
  }
  if (length - cursor > EPSILON) segments.push({ offset: cursor, width: length - cursor });
  return segments;
}

/** 开洞的垂直分块（mm，墙面局部高度）：窗下墙、洞口上方过梁。 */
export function openingVerticalParts(wall, opening) {
  if (!wall || !opening) return [];
  const wallHeight = Number(wall.height) || DEFAULT_WALL_HEIGHT;
  const sill = clamp(Number(opening.sill) || 0, 0, wallHeight);
  const height = clamp(Number(opening.height) || 0, 0, wallHeight - sill);
  const parts = [];
  if (sill > EPSILON) parts.push({ y0: 0, y1: sill });
  if (sill + height < wallHeight - EPSILON) parts.push({ y0: sill + height, y1: wallHeight });
  return parts;
}

export function openingAreaMm2(opening) {
  if (!opening) return 0;
  return Math.max(0, Number(opening.width) || 0) * Math.max(0, Number(opening.height) || 0);
}

export function signedPolygonAreaMm2(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    sum += current[0] * next[1] - next[0] * current[1];
  }
  return sum / 2;
}

export function polygonAreaMm2(points) {
  return Math.abs(signedPolygonAreaMm2(points));
}

export function mm2ToM2(areaMm2) {
  return areaMm2 / 1_000_000;
}

/** 与服务端一致：m² 保留 2 位（用于显示，不用于导出）。 */
export function areaM2(areaMm2) {
  return Math.round(mm2ToM2(areaMm2) * 100) / 100;
}

export function formatM2(areaMm2) {
  return mm2ToM2(areaMm2).toFixed(2);
}

export function polygonCentroid(points) {
  if (!Array.isArray(points) || points.length === 0) return [0, 0];
  let area = signedPolygonAreaMm2(points);
  if (Math.abs(area) <= EPSILON) {
    const sum = points.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [sum[0] / points.length, sum[1] / points.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const cross = current[0] * next[1] - next[0] * current[1];
    cx += (current[0] + next[0]) * cross;
    cy += (current[1] + next[1]) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

export function pointInPolygon(point, points) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const xi = points[i][0];
    const yi = points[i][1];
    const xj = points[j][0];
    const yj = points[j][1];
    const intersects = yi > point[1] !== yj > point[1]
      && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function coordKey(point, tolerance) {
  return `${Math.round(point[0] / tolerance)}:${Math.round(point[1] / tolerance)}`;
}

/**
 * 以墙体端点为节点、按最小面环遍历，得到闭合房间。
 * 保留逆时针（正面积）面，丢弃外部边界；loopKey 为墙 id 排序拼接。
 */
export function detectRooms(walls, options = {}) {
  const tolerance = options.tolerance || 1;
  const validWalls = (Array.isArray(walls) ? walls : []).filter((wall) => (
    wall
    && typeof wall.id === 'string'
    && Array.isArray(wall.a)
    && Array.isArray(wall.b)
    && distance(wall.a, wall.b) > tolerance
  ));
  if (validWalls.length < 3) return [];

  const nodes = new Map();
  const edges = new Map();

  function nodeFor(point) {
    const key = coordKey(point, tolerance);
    let node = nodes.get(key);
    if (!node) {
      node = { key, point: [point[0], point[1]], neighbors: [] };
      nodes.set(key, node);
    }
    return node;
  }

  for (const wall of validWalls) {
    const a = nodeFor(wall.a);
    const b = nodeFor(wall.b);
    if (a.key === b.key) continue;
    edges.set(wall.id, { id: wall.id, a: a.key, b: b.key });
    a.neighbors.push({ edgeId: wall.id, to: b.key });
    b.neighbors.push({ edgeId: wall.id, to: a.key });
  }

  for (const node of nodes.values()) {
    node.neighbors.sort((left, right) => {
      const lnode = nodes.get(left.to);
      const rnode = nodes.get(right.to);
      const la = Math.atan2(lnode.point[1] - node.point[1], lnode.point[0] - node.point[0]);
      const ra = Math.atan2(rnode.point[1] - node.point[1], rnode.point[0] - node.point[0]);
      if (la !== ra) return la - ra;
      return String(left.edgeId).localeCompare(String(right.edgeId));
    });
  }

  const visited = new Set();
  const faces = [];
  const edgeList = Array.from(edges.values());

  for (const edge of edgeList) {
    for (const direction of [[edge.a, edge.b], [edge.b, edge.a]]) {
      const [startFrom, startTo] = direction;
      if (visited.has(`${edge.id}|${startFrom}`)) continue;

      const cycleWallIds = [];
      const points = [];
      let currentEdge = edge;
      let fromKey = startFrom;
      let toKey = startTo;
      let closed = false;
      let guard = 0;

      while (guard <= edgeList.length * 2) {
        guard += 1;
        const visitKey = `${currentEdge.id}|${fromKey}`;
        if (visited.has(visitKey)) break;
        visited.add(visitKey);

        if (cycleWallIds.includes(currentEdge.id)) break;
        cycleWallIds.push(currentEdge.id);
        const fromNode = nodes.get(fromKey);
        points.push([fromNode.point[0], fromNode.point[1]]);

        const toNode = nodes.get(toKey);
        const backIndex = toNode.neighbors.findIndex(
          (neighbor) => neighbor.edgeId === currentEdge.id && neighbor.to === fromKey,
        );
        if (backIndex < 0) break;
        const next = toNode.neighbors[(backIndex - 1 + toNode.neighbors.length) % toNode.neighbors.length];
        if (!next) break;
        const nextEdge = edges.get(next.edgeId);
        if (!nextEdge) break;

        fromKey = toKey;
        toKey = next.to;
        currentEdge = nextEdge;

        if (fromKey === startFrom && currentEdge.id === edge.id) {
          closed = true;
          break;
        }
      }

      if (!closed || cycleWallIds.length < 3) continue;
      if (new Set(cycleWallIds).size !== cycleWallIds.length) continue;

      const signedArea = signedPolygonAreaMm2(points);
      if (signedArea <= tolerance * tolerance) continue;

      const loopKey = cycleWallIds.slice().sort().join('|');
      if (faces.some((face) => face.loopKey === loopKey)) continue;
      faces.push({
        loopKey,
        wallIds: cycleWallIds.slice(),
        points,
        areaMm2: signedArea,
      });
    }
  }

  faces.sort((a, b) => a.loopKey.localeCompare(b.loopKey));
  return faces;
}

/** 依据 loopKey 还原有序闭合多边形（中心线坐标）。 */
export function polygonForLoopKey(walls, loopKey, options = {}) {
  if (typeof loopKey !== 'string' || !loopKey) return [];
  const tolerance = options.tolerance || 1;
  const wanted = loopKey.split('|').filter(Boolean);
  if (wanted.length < 3) return [];
  const byId = new Map((Array.isArray(walls) ? walls : []).map((wall) => [wall.id, wall]));
  const orderedWalls = wanted.map((id) => byId.get(id));
  if (orderedWalls.some((wall) => !wall)) return [];

  const key = (point) => coordKey(point, tolerance);
  const first = orderedWalls[0];
  const points = [];
  const used = new Set();
  let currentWall = first;
  let fromPoint = first.a;

  for (let i = 0; i < orderedWalls.length; i += 1) {
    const fromKey = key(fromPoint);
    const aKey = key(currentWall.a);
    const nextPoint = aKey === fromKey ? currentWall.b : currentWall.a;
    if (aKey !== fromKey && key(currentWall.b) !== fromKey) return [];
    points.push([fromPoint[0], fromPoint[1]]);
    used.add(currentWall.id);
    const nextKey = key(nextPoint);

    const candidate = orderedWalls.find((wall) => {
      if (!wall || used.has(wall.id)) return false;
      return key(wall.a) === nextKey || key(wall.b) === nextKey;
    });
    if (!candidate && i < orderedWalls.length - 1) return [];
    if (candidate) {
      currentWall = candidate;
      fromPoint = nextPoint;
    }
  }

  if (points.length < 3) return [];
  const closingKey = key(points[0]);
  const lastWall = orderedWalls[orderedWalls.length - 1];
  const lastOther = key(lastWall.a) === key(fromPoint) ? key(lastWall.b) : key(lastWall.a);
  if (lastOther !== closingKey) return [];
  return points;
}

export function nextId(prefix, items) {
  const used = new Set((Array.isArray(items) ? items : []).map((item) => item && item.id));
  let index = 1;
  while (used.has(`${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

/**
 * 房间与材质的对账（纯函数，返回新对象）：
 * - 依据当前墙体重新识别闭环；
 * - 已有 loopKey 保留房间 id 与名称（编辑后命名稳定）；
 * - 新闭环取未占用的「房间 N」；
 * - 清理已不存在房间的材质。
 */
export function reconcileRooms(doc) {
  const walls = Array.isArray(doc && doc.walls) ? doc.walls : [];
  const existingRooms = Array.isArray(doc && doc.rooms) ? doc.rooms : [];
  const materials = (doc && doc.materials) || {};
  const faces = detectRooms(walls);
  const existingByKey = new Map(existingRooms.map((room) => [room.loopKey, room]));
  const usedNames = new Set();
  const usedIds = new Set(existingRooms.map((room) => room.id));

  const rooms = faces.map((face) => {
    const existing = existingByKey.get(face.loopKey);
    if (existing) {
      usedNames.add(existing.name);
      return { ...existing };
    }
    return null;
  });

  let counter = 1;
  for (let i = 0; i < rooms.length; i += 1) {
    if (rooms[i]) continue;
    let name = `房间 ${counter}`;
    while (usedNames.has(name)) {
      counter += 1;
      name = `房间 ${counter}`;
    }
    usedNames.add(name);
    let id = nextId('r', Array.from(usedIds).map((value) => ({ id: value })));
    while (usedIds.has(id)) id = `${id}x`;
    usedIds.add(id);
    rooms[i] = { id, name, loopKey: faces[i].loopKey };
  }

  const keepFloor = {};
  const keepWall = {};
  for (const room of rooms) {
    if (materials.floor && materials.floor[room.id] !== undefined) {
      keepFloor[room.id] = materials.floor[room.id];
    }
    if (materials.wall && materials.wall[room.id] !== undefined) {
      keepWall[room.id] = materials.wall[room.id];
    }
  }

  return {
    rooms,
    materials: { ...materials, floor: keepFloor, wall: keepWall },
    faces,
  };
}
