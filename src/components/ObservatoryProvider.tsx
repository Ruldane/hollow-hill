"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Observatory } from "@/client/observatory";
import { Store, initialUi, useStoreValue, type UiState } from "@/client/store";

const Ctx = createContext<Observatory | null>(null);
const idleStore = new Store<UiState>(initialUi);

/**
 * One Observatory (and one colony worker) per mounted page. Each effect run
 * makes its own and disposes it on cleanup, so React StrictMode's double
 * mount never leaves a second worker running.
 */
export function ObservatoryProvider({ children }: { children: ReactNode }) {
  const [obs, setObs] = useState<Observatory | null>(null);
  useEffect(() => {
    const o = new Observatory();
    o.start();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the instance must exist before children can attach to it
    setObs(o);
    return () => {
      o.dispose();
      setObs(null);
    };
  }, []);
  return <Ctx.Provider value={obs}>{children}</Ctx.Provider>;
}

export function useObservatory(): Observatory | null {
  return useContext(Ctx);
}

export function useUi<R>(select: (s: UiState) => R): R {
  const obs = useContext(Ctx);
  return useStoreValue(obs?.store ?? idleStore, select);
}
