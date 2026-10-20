import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCatalog } from '../../web/js/catalog.js';
import { CSRF_COOKIE_NAMES } from '../../web/js/api.js';

/** 与后端 /api/v1/catalog 响应同形：{furniture:[...], materials:[{kind:...}]} */
const BACKEND_CATALOG = {
  furniture: [
    { id: 'sofa-2', name: '双人沙发', width: 1600, depth: 850, height: 800, color: '#7d8b99' },
    { id: 'sofa-3', name: '三人沙发', width: 2100, depth: 900, height: 800, color: '#8a9aa8' },
    { id: 'armchair', name: '单人扶手椅', width: 800, depth: 800, height: 850, color: '#a98467' },
    { id: 'coffee-table', name: '茶几', width: 1000, depth: 600, height: 420, color: '#b08968' },
    { id: 'dining-table', name: '餐桌', width: 1400, depth: 800, height: 750, color: '#9c6644' },
    { id: 'chair', name: '餐椅', width: 450, depth: 450, height: 900, color: '#7f5539' },
    { id: 'bed-double', name: '双人床', width: 1800, depth: 2000, height: 500, color: '#ced4da' },
    { id: 'wardrobe', name: '衣柜', width: 1800, depth: 600, height: 2200, color: '#6c757d' },
    { id: 'desk', name: '书桌', width: 1200, depth: 600, height: 750, color: '#8d6e63' },
    { id: 'tv-stand', name: '电视柜', width: 1600, depth: 400, height: 450, color: '#495057' },
    { id: 'rug', name: '地毯', width: 2000, depth: 1400, height: 20, color: '#d8c3a5' },
    { id: 'plant', name: '绿植', width: 500, depth: 500, height: 1200, color: '#4f772d' },
  ],
  materials: [
    { id: 'floor-oak', name: '浅橡木地板', kind: 'floor', color: '#c8a97e' },
    { id: 'floor-walnut', name: '胡桃木地板', kind: 'floor', color: '#8b5a3c' },
    { id: 'floor-tile-grey', name: '灰色瓷砖', kind: 'floor', color: '#b8bcc0' },
    { id: 'floor-marble', name: '白色大理石', kind: 'floor', color: '#e8e6df' },
    { id: 'paint-warm-white', name: '暖白乳胶漆', kind: 'wall', color: '#f3efe6' },
    { id: 'paint-sage', name: '鼠尾草绿', kind: 'wall', color: '#a8b5a0' },
    { id: 'paint-sky', name: '天空蓝', kind: 'wall', color: '#a9c4d8' },
    { id: 'wall-tile-white', name: '白色墙砖', kind: 'wall', color: '#eef0f1' },
  ],
};

test('目录归一化满足 ≥9 件家具、≥6 种材质（4 地面 + 4 墙面）', () => {
  const catalog = normalizeCatalog(BACKEND_CATALOG);
  assert.equal(catalog.furniture.length, 12);
  assert.equal(catalog.floorMaterials.length, 4);
  assert.equal(catalog.wallMaterials.length, 4);
  assert.equal(catalog.counts.furniture, 12);
  assert.equal(catalog.counts.materials, 8);
  assert.ok(catalog.furniture.length >= 9);
  assert.ok(catalog.counts.materials >= 6);
});

test('后端 kind 字段被正确分类，家具尺寸与颜色可用', () => {
  const catalog = normalizeCatalog(BACKEND_CATALOG);
  assert.deepEqual(
    catalog.floorMaterials.map((item) => item.id),
    ['floor-oak', 'floor-walnut', 'floor-tile-grey', 'floor-marble'],
  );
  assert.deepEqual(
    catalog.wallMaterials.map((item) => item.id),
    ['paint-warm-white', 'paint-sage', 'paint-sky', 'wall-tile-white'],
  );
  const sofa = catalog.byId.get('sofa-2');
  assert.equal(sofa.name, '双人沙发');
  assert.equal(sofa.width, 1600);
  assert.equal(sofa.depth, 850);
  assert.equal(sofa.height, 800);
  assert.equal(sofa.kind, 'sofa');
  assert.equal(sofa.color, '#7d8b99');
  assert.equal(catalog.byId.get('paint-sage').kind, 'wall');
});

test('目录兼容 materials.floor/wall 嵌套形态', () => {
  const catalog = normalizeCatalog({
    furniture: [{ id: 'chair', name: '餐椅', width: 450, depth: 450, height: 900 }],
    materials: {
      floor: [{ id: 'floor-oak', name: '浅橡木地板', color: '#c8a97e' }],
      wall: [{ id: 'paint-sage', name: '鼠尾草绿', color: '#a8b5a0' }],
    },
  });
  assert.deepEqual(catalog.floorMaterials.map((item) => item.id), ['floor-oak']);
  assert.deepEqual(catalog.wallMaterials.map((item) => item.id), ['paint-sage']);
});

test('CSRF 双提交读取后端 cookie 名 kj_csrf', () => {
  assert.ok(CSRF_COOKIE_NAMES.includes('kj_csrf'));
});
