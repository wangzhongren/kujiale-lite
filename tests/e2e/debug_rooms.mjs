import { detectRooms, reconcileRooms } from '../../web/js/geometry.js';

const base = [
  { id: 'w1', a: [0, 0], b: [4000, 0] },
  { id: 'w2', a: [4000, 0], b: [4000, 3000] },
  { id: 'w3', a: [4000, 3000], b: [0, 3000] },
  { id: 'w4', a: [0, 3000], b: [0, 0] },
];
const extra = [
  { id: 'w5', a: [4000, 0], b: [7000, 0] },
  { id: 'w6', a: [7000, 0], b: [7000, 3000] },
  { id: 'w7', a: [7000, 3000], b: [4000, 3000] },
];
const exact = [...base, ...extra];
console.log('exact faces', detectRooms(exact).map((f) => [f.loopKey, f.areaMm2]));
const doc = { walls: exact, rooms: [{ id: 'r1', name: '房间 1', loopKey: 'w1|w2|w3|w4' }], materials: {} };
console.log('exact reconcile', JSON.stringify(reconcileRooms(doc).rooms));

const noisy = [...base, ...extra.map((wall) => ({
  ...wall,
  a: [wall.a[0] + 9, wall.a[1] - 7],
  b: [wall.b[0] + 9, wall.b[1] - 7],
}))];
console.log('noisy faces', detectRooms(noisy).map((f) => [f.loopKey, f.areaMm2]));

const chain = [...base, { id: 'w5', a: [4000, 0], b: [7009, 0] }, { id: 'w6', a: [7009, 0], b: [7009, 3007] }, { id: 'w7', a: [7009, 3007], b: [4000, 3000] }];
console.log('chain faces', detectRooms(chain).map((f) => [f.loopKey, f.areaMm2]));
