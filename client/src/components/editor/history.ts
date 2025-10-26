export type Rect = { x: number; y: number; w: number; h: number };

export type Patch = {
  bbox: Rect;
  beforePNG: Blob;
  afterPNG: Blob;
};

export type EditCommandType = "INPAINT_APPLY" | "RESTORE_REGION";

export type EditCommand = {
  type: EditCommandType;
  description: string;
  patch: Patch;
};

export class HistoryManager {
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  push(cmd: EditCommand) {
    this.undoStack.push(cmd);
    this.redoStack = [];
  }

  popUndo(): EditCommand | undefined {
    const c = this.undoStack.pop();
    if (c) this.redoStack.push(c);
    return c;
  }

  popRedo(): EditCommand | undefined {
    const c = this.redoStack.pop();
    if (c) this.undoStack.push(c);
    return c;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
  }

  state() {
    return { undo: this.undoStack.length, redo: this.redoStack.length };
  }
}
