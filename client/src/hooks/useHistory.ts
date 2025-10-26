import { useCallback, useRef, useState } from "react";

export type Action<T=any> = { id: string; type: string; payload: T };

export function useHistory<T=any>(initial: T) {
  const [state, setState] = useState<T>(initial);
  const past = useRef<Action<T>[]>([]);
  const future = useRef<Action<T>[]>([]);

  const apply = useCallback((action: Action<T>, reducer: (s: T, a: Action<T>) => T) => {
    past.current.push(action);
    const next = reducer(state, action);
    setState(next);
    future.current = [];
  }, [state]);

  const undo = useCallback((reducer: (s: T, a: Action<T>) => T) => {
    const action = past.current.pop();
    if (!action) return;
    future.current.push(action);
    setState(reducer(state, { ...action, type: "UNDO" }));
  }, [state]);

  const redo = useCallback((reducer: (s: T, a: Action<T>) => T) => {
    const action = future.current.pop();
    if (!action) return;
    past.current.push(action);
    setState(reducer(state, action));
  }, [state]);

  return { state, setState, apply, undo, redo, canUndo: past.current.length>0, canRedo: future.current.length>0 };
}
