import { createContext, useContext, useRef, useCallback, type ReactNode } from "react";

interface FolderState {
  folderId: string | null;
  scrollY: number;
  selected: string[];
  breadcrumbs: Array<{ id: string | null; name: string }>;
}

interface NavCtx {
  getFolderState: (routeKey: string) => FolderState | null;
  setFolderState: (routeKey: string, state: FolderState) => void;
  clearFolderState: (routeKey: string) => void;
}

const Ctx = createContext<NavCtx>({
  getFolderState: () => null,
  setFolderState: () => {},
  clearFolderState: () => {},
});

export function NavigationProvider({ children }: { children: ReactNode }) {
  // useRef — no re-renders, pure session memory
  const store = useRef<Map<string, FolderState>>(new Map());

  const getFolderState = useCallback((key: string) => store.current.get(key) ?? null, []);
  const setFolderState = useCallback((key: string, state: FolderState) => { store.current.set(key, state); }, []);
  const clearFolderState = useCallback((key: string) => { store.current.delete(key); }, []);

  return (
    <Ctx.Provider value={{ getFolderState, setFolderState, clearFolderState }}>
      {children}
    </Ctx.Provider>
  );
}

export function useNavigation() {
  return useContext(Ctx);
}

export type { FolderState };
