import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, EditError } from '../../web/js/store.js';
import { formatM2, polygonAreaMm2, polygonForLoopKey } from '../../web/js/geometry.js';

const RECT_WALLS = [
  { a: [0, 0], b: [4000, 0] },
  { a: [4000, 0], b: [4000, 3000] },
  { a: [4000, 3000], b: [0, 3000] },
  { a: [0, 3000], b: [0, 0] },
];

function buildRoom(store = createStore()) {
  for (const wall of RECT_WALLS) store.addWall(wall);
  return store;
}

test('store 画闭合矩形：自动识别房间，预览面积 12.00 m²（服务端同基准）', () => {
  const store = buildRoom();
  const doc = store.getDoc();
  assert.equal(doc.walls.length, 4);
  assert.equal(doc.rooms.length, 1);
  assert.equal(doc.rooms[0].loopKey, 'w1|w2|w3|w4');
  const points = polygonForLoopKey(doc.walls, doc.rooms[0].loopKey);
  assert.equal(polygonAreaMm2(points), 12_000_000);
  assert.equal(formatM2(polygonAreaMm2(points)), '12.00');
  assert.equal(store.getState().dirty, true);
});

test('store 撤销/重做作用于真实文档，重做栈在新编辑时清空', () => {
  const store = createStore();
  store.addWall(RECT_WALLS[0]);
  store.addWall(RECT_WALLS[1]);
  assert.equal(store.getDoc().walls.length, 2);
  assert.equal(store.undo(), true);
  assert.equal(store.getDoc().walls.length, 1);
  assert.equal(store.redo(), true);
  assert.equal(store.getDoc().walls.length, 2);

  store.undo();
  assert.equal(store.getState().canRedo, true);
  store.addWall(RECT_WALLS[2]);
  assert.equal(store.getState().canRedo, false);
  assert.equal(store.getDoc().walls.length, 2);
});

test('store 保存成功清除脏标记并推进 revision', () => {
  const store = createStore({ plan: { id: 7, name: '演示户型', revision: 3 } });
  store.addWall(RECT_WALLS[0]);
  assert.equal(store.getState().dirty, true);
  store.markSaved({ revision: 4, name: '演示户型' });
  assert.equal(store.getState().dirty, false);
  assert.equal(store.getPlan().revision, 4);
  assert.equal(store.getState().saveError, null);
});

test('store 保存期间继续编辑时仍保持脏标记（不丢当前编辑）', () => {
  const store = createStore({ plan: { id: 1, name: 'A', revision: 1 } });
  store.addWall(RECT_WALLS[0]);
  const versionAtRequest = store.getState().version;
  store.addWall(RECT_WALLS[1]);
  store.markSaved({ revision: 2, savedVersion: versionAtRequest });
  assert.equal(store.getState().dirty, true);
  assert.equal(store.getPlan().revision, 2);
});

test('store 非法输入抛错且不改变文档', () => {
  const store = createStore();
  assert.throws(() => store.addWall({ a: [0, 0], b: [0, 0] }), EditError);
  assert.throws(() => store.addWall({ a: [0, 0], b: [0.5, 0] }), /长度必须大于 0/);
  assert.equal(store.getDoc().walls.length, 0);
  assert.throws(() => store.addFurniture({ catalogId: '' }), /缺少家具目录 id/);
  assert.throws(() => store.setName('   '), /方案名称不能为空/);
  assert.throws(() => store.setName('x'.repeat(81)), /80/);
});

test('store 门窗落位、越界校验与撤销', () => {
  const store = createStore();
  store.addWall({ a: [0, 0], b: [4000, 0] });
  const openingId = store.addOpening({
    wallId: 'w1',
    type: 'door',
    centerOffset: 2000,
    width: 900,
  });
  const opening = store.getDoc().openings.find((item) => item.id === openingId);
  assert.equal(opening.offset, 1550);
  assert.equal(opening.height, 2100);
  assert.throws(
    () => store.addOpening({ wallId: 'w1', type: 'window', centerOffset: 2000, width: 900 }),
    /重叠/,
  );
  store.undo();
  assert.equal(store.getDoc().openings.length, 0);
  store.redo();
  assert.equal(store.getDoc().openings.length, 1);
});

test('store 房间命名与材质会随撤销恢复，且材质按房间保留', () => {
  const store = buildRoom();
  const roomId = store.getDoc().rooms[0].id;
  store.setRoomName(roomId, '客厅');
  store.setMaterial('floor', roomId, 'floor-oak');
  store.setMaterial('wall', roomId, 'paint-sage');
  assert.equal(store.getDoc().rooms[0].name, '客厅');
  assert.deepEqual(store.getDoc().materials.floor, { [roomId]: 'floor-oak' });
  assert.deepEqual(store.getDoc().materials.wall, { [roomId]: 'paint-sage' });

  store.undo();
  assert.deepEqual(store.getDoc().materials.wall, {});
  store.undo();
  assert.deepEqual(store.getDoc().materials.floor, {});
  store.undo();
  assert.equal(store.getDoc().rooms[0].name, '房间 1');
});

test('store 删除墙体时清理门窗与失效房间，撤销可完整恢复', () => {
  const store = buildRoom();
  const roomId = store.getDoc().rooms[0].id;
  store.setMaterial('floor', roomId, 'floor-oak');
  store.addOpening({ wallId: 'w1', type: 'door', centerOffset: 2000, width: 900 });
  const before = JSON.stringify(store.getDoc());
  assert.equal(store.deleteWall('w1'), true);
  assert.equal(store.getDoc().walls.length, 3);
  assert.equal(store.getDoc().openings.length, 0);
  assert.equal(store.getDoc().rooms.length, 0);
  assert.deepEqual(store.getDoc().materials.floor, {});
  store.undo();
  assert.equal(JSON.stringify(store.getDoc()), before);
});
