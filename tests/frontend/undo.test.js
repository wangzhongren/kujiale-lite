import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, DEFAULT_LIMIT } from '../../web/js/undo.js';

function makeCommand(log, name) {
  return {
    label: name,
    redo() {
      log.push(`redo:${name}`);
    },
    undo() {
      log.push(`undo:${name}`);
    },
  };
}

test('默认上限为 50', () => {
  const history = createHistory();
  assert.equal(DEFAULT_LIMIT, 50);
  assert.equal(history.limit, 50);
});

test('提交即执行、撤销与重做成对出现', () => {
  const log = [];
  const history = createHistory();
  history.push(makeCommand(log, 'A'));
  history.push(makeCommand(log, 'B'));
  assert.deepEqual(log, ['redo:A', 'redo:B']);
  assert.equal(history.undoSize, 2);
  assert.equal(history.undoLabel, 'B');

  assert.equal(history.undo(), true);
  assert.equal(history.undo(), true);
  assert.deepEqual(log, ['redo:A', 'redo:B', 'undo:B', 'undo:A']);
  assert.equal(history.canUndo, false);
  assert.equal(history.redoSize, 2);

  assert.equal(history.redo(), true);
  assert.equal(history.redo(), true);
  assert.deepEqual(log, [
    'redo:A', 'redo:B', 'undo:B', 'undo:A', 'redo:A', 'redo:B',
  ]);
  assert.equal(history.canRedo, false);
});

test('空栈撤销/重做返回 false 且不改变状态', () => {
  const history = createHistory();
  assert.equal(history.undo(), false);
  assert.equal(history.redo(), false);
  assert.equal(history.undoSize, 0);
  assert.equal(history.redoSize, 0);
});

test('撤销栈上限 50：最旧命令被丢弃且不可再撤销', () => {
  const events = [];
  const history = createHistory();
  for (let i = 0; i < 60; i += 1) {
    history.push({
      label: `c${i}`,
      redo() {
        events.push(`redo:${i}`);
      },
      undo() {
        events.push(`undo:${i}`);
      },
    });
  }
  assert.equal(history.undoSize, 50);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(history.undo(), true);
  }
  assert.equal(history.undo(), false);
  assert.equal(history.undoSize, 0);
  assert.equal(history.redoSize, 50);

  const undone = events.filter((event) => event.startsWith('undo:'));
  assert.equal(undone.length, 50);
  assert.equal(undone[0], 'undo:59');
  assert.equal(undone[49], 'undo:10');
  for (let i = 0; i < 10; i += 1) {
    assert.equal(undone.includes(`undo:${i}`), false, `最旧的 c${i} 必须已被丢弃`);
  }
});

test('新命令清空重做栈', () => {
  const log = [];
  const history = createHistory();
  history.push(makeCommand(log, 'A'));
  history.push(makeCommand(log, 'B'));
  history.undo();
  assert.equal(history.canRedo, true);
  history.push(makeCommand(log, 'C'));
  assert.equal(history.canRedo, false);
  assert.equal(history.redo(), false);
  assert.deepEqual(log, ['redo:A', 'redo:B', 'undo:B', 'redo:C']);
});

test('命令 redo 抛错时不入栈、不清空重做栈', () => {
  const log = [];
  const history = createHistory();
  history.push(makeCommand(log, 'A'));
  history.undo();
  const failing = {
    label: 'bad',
    redo() {
      throw new Error('boom');
    },
    undo() {},
  };
  assert.throws(() => history.push(failing), /boom/);
  assert.equal(history.undoSize, 0);
  assert.equal(history.canRedo, true);
  assert.equal(history.redo(), true);
  assert.deepEqual(log, ['redo:A', 'undo:A', 'redo:A']);
});

test('命令形状与上限参数校验', () => {
  const history = createHistory({ limit: 2 });
  assert.throws(() => history.push({}), TypeError);
  assert.throws(() => createHistory({ limit: 0 }), RangeError);
  assert.throws(() => createHistory({ limit: 1.5 }), RangeError);
});

test('subscribe 在 push/undo/redo/clear 时通知，退订后不再通知', () => {
  let calls = 0;
  const history = createHistory();
  const unsubscribe = history.subscribe(() => {
    calls += 1;
  });
  history.push(makeCommand([], 'A'));
  history.undo();
  history.redo();
  history.clear();
  assert.equal(calls, 4);
  unsubscribe();
  history.push(makeCommand([], 'B'));
  assert.equal(calls, 4);
});

test('自定义上限仍保留最近命令', () => {
  const log = [];
  const history = createHistory({ limit: 2 });
  history.push(makeCommand(log, 'A'));
  history.push(makeCommand(log, 'B'));
  history.push(makeCommand(log, 'C'));
  assert.equal(history.undoSize, 2);
  assert.equal(history.undoLabel, 'C');
  assert.equal(history.undo(), true);
  assert.equal(history.undo(), true);
  assert.equal(history.undo(), false);
  assert.equal(log.includes('undo:A'), false);
  assert.equal(log.includes('undo:B'), true);
  assert.equal(log.includes('undo:C'), true);
});
