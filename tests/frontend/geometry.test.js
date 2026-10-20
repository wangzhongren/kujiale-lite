import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areaM2,
  detectRooms,
  distance,
  formatM2,
  mm2ToM2,
  openingAreaMm2,
  openingVerticalParts,
  pointInPolygon,
  pointToSegment,
  polygonAreaMm2,
  polygonCentroid,
  polygonForLoopKey,
  reconcileRooms,
  snapAngle,
  snapPoint,
  wallSegmentsWithOpenings,
} from '../../web/js/geometry.js';

const RECT_WALLS = [
  { id: 'w1', a: [0, 0], b: [4000, 0], thickness: 120, height: 2800 },
  { id: 'w2', a: [4000, 0], b: [4000, 3000], thickness: 120, height: 2800 },
  { id: 'w3', a: [4000, 3000], b: [0, 3000], thickness: 120, height: 2800 },
  { id: 'w4', a: [0, 3000], b: [0, 0], thickness: 120, height: 2800 },
];

const RECT_POINTS = [[0, 0], [4000, 0], [4000, 3000], [0, 3000]];

test('面积基准：4000×3000mm = 12.00 m²（与服务端同口径）', () => {
  const mm2 = polygonAreaMm2(RECT_POINTS);
  assert.equal(mm2, 12_000_000);
  assert.equal(mm2ToM2(mm2), 12);
  assert.equal(areaM2(mm2), 12);
  assert.equal(formatM2(mm2), '12.00');
});

test('L 形多边形鞋带面积为 18.00 m²', () => {
  const points = [[0, 0], [4000, 0], [4000, 3000], [2000, 3000], [2000, 6000], [0, 6000]];
  assert.equal(polygonAreaMm2(points), 18_000_000);
  assert.equal(formatM2(polygonAreaMm2(points)), '18.00');
});

test('多边形质心与点包含判断', () => {
  assert.deepEqual(polygonCentroid(RECT_POINTS), [2000, 1500]);
  assert.equal(pointInPolygon([2000, 1500], RECT_POINTS), true);
  assert.equal(pointInPolygon([-1, 1500], RECT_POINTS), false);
  assert.equal(pointInPolygon([4001, 1500], RECT_POINTS), false);
});

test('吸附：端点优先于网格，阈值外回落到网格', () => {
  const endpointSnap = snapPoint([3980, 20], {
    grid: 100,
    endpoints: [[4000, 0], [0, 0]],
    threshold: 50,
  });
  assert.deepEqual(endpointSnap, { x: 4000, y: 0, snapped: true, reason: 'endpoint' });

  const gridSnap = snapPoint([1049, 948], { grid: 100, endpoints: [], threshold: 50 });
  assert.deepEqual(gridSnap, { x: 1000, y: 900, snapped: true, reason: 'grid' });

  const noSnap = snapPoint([1049, 948], { grid: 100, snapGrid: false, endpoints: [] });
  assert.deepEqual(noSnap, { x: 1049, y: 948, snapped: false, reason: 'none' });
});

test('角度吸附保持长度不变并取最近 15°', () => {
  const result = snapAngle([0, 0], [4000, 1000], { step: 15 });
  const expectedAngle = Math.atan2(1000, 4000) * 180 / Math.PI;
  assert.ok(Math.abs(expectedAngle - 14.036) < 0.01);
  assert.equal(result.angleDeg, 15);
  assert.ok(Math.abs(result.length - distance([0, 0], [4000, 1000])) < 1e-9);
  assert.ok(Math.abs(result.x - Math.cos(15 * Math.PI / 180) * result.length) < 1e-6);
  assert.ok(Math.abs(result.y - Math.sin(15 * Math.PI / 180) * result.length) < 1e-6);
});

test('点到线段距离与投影参数', () => {
  const hit = pointToSegment([1000, 300], [0, 0], [2000, 0]);
  assert.equal(hit.distance, 300);
  assert.equal(hit.t, 0.5);
  assert.deepEqual(hit.closest, [1000, 0]);

  const outside = pointToSegment([-500, 0], [0, 0], [2000, 0]);
  assert.equal(outside.distance, 500);
  assert.equal(outside.t, 0);
});

test('墙体开洞切分：门洞两侧为整高墙段', () => {
  const wall = RECT_WALLS[0];
  const segments = wallSegmentsWithOpenings(wall, [
    { id: 'o1', wallId: 'w1', type: 'door', offset: 500, width: 900, height: 2100, sill: 0 },
  ]);
  assert.deepEqual(segments, [
    { offset: 0, width: 500 },
    { offset: 1400, width: 2600 },
  ]);
  const total = segments.reduce((sum, segment) => sum + segment.width, 0);
  assert.equal(total, 3100);
  assert.equal(total + 900, 4000);
});

test('开洞越界时按墙长裁剪且不产生负宽度', () => {
  const wall = RECT_WALLS[0];
  const segments = wallSegmentsWithOpenings(wall, [
    { id: 'o1', wallId: 'w1', offset: 3500, width: 900, height: 2100, sill: 0 },
  ]);
  assert.deepEqual(segments, [{ offset: 0, width: 3500 }]);
});

test('开洞垂直分块：窗有窗下墙与过梁，门只有过梁', () => {
  const wall = RECT_WALLS[0];
  const windowParts = openingVerticalParts(wall, {
    type: 'window', width: 1200, height: 1400, sill: 900,
  });
  assert.deepEqual(windowParts, [
    { y0: 0, y1: 900 },
    { y0: 2300, y1: 2800 },
  ]);
  const doorParts = openingVerticalParts(wall, {
    type: 'door', width: 900, height: 2100, sill: 0,
  });
  assert.deepEqual(doorParts, [{ y0: 2100, y1: 2800 }]);
  assert.equal(openingAreaMm2({ width: 900, height: 2100 }), 1_890_000);
});

test('房间识别：4000×3000 闭合墙得到 12.00 m² 与稳定 loopKey', () => {
  const faces = detectRooms(RECT_WALLS);
  assert.equal(faces.length, 1);
  assert.equal(faces[0].loopKey, 'w1|w2|w3|w4');
  assert.equal(faces[0].areaMm2, 12_000_000);
  assert.equal(formatM2(faces[0].areaMm2), '12.00');
  assert.equal(faces[0].points.length, 4);
});

test('房间识别：两间共享墙得到 12.00 与 9.00 两个房间', () => {
  const walls = [
    { id: 'w1', a: [0, 0], b: [4000, 0], thickness: 120, height: 2800 },
    { id: 'w2', a: [4000, 0], b: [7000, 0], thickness: 120, height: 2800 },
    { id: 'w3', a: [7000, 0], b: [7000, 3000], thickness: 120, height: 2800 },
    { id: 'w4', a: [7000, 3000], b: [4000, 3000], thickness: 120, height: 2800 },
    { id: 'w5', a: [4000, 3000], b: [0, 3000], thickness: 120, height: 2800 },
    { id: 'w6', a: [0, 3000], b: [0, 0], thickness: 120, height: 2800 },
    { id: 'w7', a: [4000, 0], b: [4000, 3000], thickness: 120, height: 2800 },
  ];
  const faces = detectRooms(walls);
  assert.equal(faces.length, 2);
  const areas = faces.map((face) => formatM2(face.areaMm2)).sort();
  assert.deepEqual(areas, ['12.00', '9.00']);
  const loopKeys = new Set(faces.map((face) => face.loopKey));
  assert.equal(loopKeys.has('w1|w5|w6|w7'), true);
  assert.equal(loopKeys.has('w2|w3|w4|w7'), true);
});

test('loopKey 可还原有序闭合多边形', () => {
  const points = polygonForLoopKey(RECT_WALLS, 'w1|w2|w3|w4');
  assert.equal(points.length, 4);
  assert.equal(polygonAreaMm2(points), 12_000_000);
  assert.deepEqual(polygonForLoopKey(RECT_WALLS, 'w1|w2'), []);
  assert.deepEqual(polygonForLoopKey(RECT_WALLS, 'w1|w2|w3|w9'), []);
});

test('房间对账保留命名与 id，清理孤立材质', () => {
  const doc = {
    walls: RECT_WALLS,
    rooms: [{ id: 'r7', name: '客厅', loopKey: 'w1|w2|w3|w4' }],
    materials: {
      floor: { r7: 'floor-oak', r9: 'floor-tile' },
      wall: { r7: 'paint-warm-white', r9: 'paint-sage' },
    },
  };
  const result = reconcileRooms(doc);
  assert.equal(result.rooms.length, 1);
  assert.deepEqual(result.rooms[0], { id: 'r7', name: '客厅', loopKey: 'w1|w2|w3|w4' });
  assert.deepEqual(result.materials.floor, { r7: 'floor-oak' });
  assert.deepEqual(result.materials.wall, { r7: 'paint-warm-white' });
});

test('房间对账为新闭环命名且不覆盖已有房间名', () => {
  const walls = [
    { id: 'w1', a: [0, 0], b: [4000, 0] },
    { id: 'w2', a: [4000, 0], b: [7000, 0] },
    { id: 'w3', a: [7000, 0], b: [7000, 3000] },
    { id: 'w4', a: [7000, 3000], b: [4000, 3000] },
    { id: 'w5', a: [4000, 3000], b: [0, 3000] },
    { id: 'w6', a: [0, 3000], b: [0, 0] },
    { id: 'w7', a: [4000, 0], b: [4000, 3000] },
  ];
  const doc = {
    walls,
    rooms: [{ id: 'r2', name: '房间 1', loopKey: 'w1|w5|w6|w7' }],
    materials: {},
  };
  const result = reconcileRooms(doc);
  assert.equal(result.rooms.length, 2);
  const kept = result.rooms.find((room) => room.id === 'r2');
  assert.deepEqual(kept, { id: 'r2', name: '房间 1', loopKey: 'w1|w5|w6|w7' });
  const added = result.rooms.find((room) => room.id !== 'r2');
  assert.equal(added.name, '房间 2');
  assert.equal(added.loopKey, 'w2|w3|w4|w7');
  assert.equal(added.id, 'r1');
});
