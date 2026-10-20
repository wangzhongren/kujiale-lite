export const DEFAULT_LIMIT = 50;

function assertCommand(command) {
  if (!command || typeof command !== 'object') {
    throw new TypeError('command 必须是对象');
  }
  if (typeof command.redo !== 'function' || typeof command.undo !== 'function') {
    throw new TypeError('command 必须提供 redo() 与 undo()');
  }
}

/**
 * 命令栈：undo/redo 上限固定为本栈容量，新命令清空重做栈。
 * 命令在提交时立即执行 redo()；执行抛错时不入栈、不清空重做栈。
 */
export function createHistory({ limit = DEFAULT_LIMIT } = {}) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit 必须是正整数');
  }

  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();

  const history = {
    get limit() {
      return limit;
    },
    get undoSize() {
      return undoStack.length;
    },
    get redoSize() {
      return redoStack.length;
    },
    get canUndo() {
      return undoStack.length > 0;
    },
    get canRedo() {
      return redoStack.length > 0;
    },
    get undoLabel() {
      return undoStack.length ? undoStack[undoStack.length - 1].label || '' : '';
    },
    get redoLabel() {
      return redoStack.length ? redoStack[redoStack.length - 1].label || '' : '';
    },
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('订阅者必须是函数');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    push(command) {
      assertCommand(command);
      command.redo();
      undoStack.push(command);
      while (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      notify();
      return command;
    },
    undo() {
      const command = undoStack.pop();
      if (!command) return false;
      command.undo();
      redoStack.push(command);
      notify();
      return true;
    },
    redo() {
      const command = redoStack.pop();
      if (!command) return false;
      command.redo();
      undoStack.push(command);
      notify();
      return true;
    },
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      notify();
    },
  };

  function notify() {
    for (const fn of Array.from(listeners)) fn(history);
  }

  return history;
}
