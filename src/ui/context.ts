import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ShownDiagnostic } from '../app/pipeline';
import type { ParamPath } from '../app/stages';
import type { Store } from '../app/store';

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('A component that reads the store must sit inside StoreContext.');
  // Reading the tick subscribes the component, so it draws again on every change the pipeline makes.
  void store.tick.value;
  return store;
}

/** The diagnostics that belong under each control, gathered once per change for the whole sidebar. */
export const ProblemsContext = createContext<Map<ParamPath, ShownDiagnostic[]>>(new Map());

export function useProblems(path: ParamPath): ShownDiagnostic[] {
  return useContext(ProblemsContext).get(path) ?? [];
}
