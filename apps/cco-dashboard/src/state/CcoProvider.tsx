import { createContext, useContext, useEffect, useReducer, type Dispatch, type ReactNode } from 'react';
import { ccoReducer, clockString, initialState } from './reducer';
import type { CcoAction, CcoState } from './types';

const StateContext = createContext<CcoState | null>(null);
const DispatchContext = createContext<Dispatch<CcoAction> | null>(null);

export function CcoProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(ccoReducer, undefined, () => initialState(new Date()));

  useEffect(() => {
    const rate = state.simRate;
    if (rate === 0) return;
    const id = setInterval(() => dispatch({ type: 'TICK', dtSec: rate, at: clockString(new Date()) }), 1000);
    return () => clearInterval(id);
  }, [state.simRate]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useCcoState(): CcoState {
  const state = useContext(StateContext);
  if (!state) throw new Error('useCcoState fora do <CcoProvider>');
  return state;
}

export function useCcoDispatch(): Dispatch<CcoAction> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error('useCcoDispatch fora do <CcoProvider>');
  return dispatch;
}

/** Carimbo de horário para ações do operador — o reducer não lê o relógio. */
export function stamp(): string {
  return clockString(new Date());
}
