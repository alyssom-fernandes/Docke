import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

export type TaskStatus = "running" | "done" | "failed";
export type TaskKind = "upload" | "ocr" | "zip" | "export";
// Fase 11.2: estados separados na fila — upload (subindo bytes, com % real
// quando multipart) é uma etapa distinta de processing (OCR rodando no
// worker, fora do controle do cliente). Antes as duas ficavam disfarçadas
// sob o mesmo status "running" com só o texto do label mudando.
export type TaskPhase = "uploading" | "processing";

export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
  phase?: TaskPhase;
  progress?: number; // 0-100, undefined = indeterminate
  error?: string;
  createdAt: number;
}

interface TaskCtx {
  tasks: Task[];
  addTask: (task: Omit<Task, "id" | "createdAt">) => string;
  updateTask: (id: string, patch: Partial<Omit<Task, "id" | "createdAt">>) => void;
  removeTask: (id: string) => void;
  clearDone: () => void;
  // Fase 11.3: retry por tarefa — quem cria a tarefa (ex: upload de um
  // arquivo) registra como refazer só AQUELE item; o Task Center (que não
  // tem acesso ao File original) só precisa saber que existe um retry pra
  // aquele id e chamar. Nunca serializado (função, não vai pro sessionStorage).
  registerRetry: (id: string, fn: () => void) => void;
  retry: (id: string) => void;
}

const Ctx = createContext<TaskCtx>({
  tasks: [],
  addTask: () => "",
  updateTask: () => {},
  removeTask: () => {},
  clearDone: () => {},
  registerRetry: () => {},
  retry: () => {},
});

let _seq = 0;

const STORAGE_KEY = "docke_task_center";

// Sobrevive a um reload durante um upload em andamento — sem isso, recarregar
// a página no meio de um envio faz a tarefa "sumir" mesmo que o upload real
// continue (ou tenha terminado) no servidor.
function loadPersisted(): Task[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Task[];
    // tarefa "running" que sobrou de uma aba fechada no meio do processo
    // não pode ficar girando pra sempre — marca como falha ao recarregar.
    return parsed.map((t) => (t.status === "running" ? { ...t, status: "failed" as const, error: "Interrompido ao recarregar a página." } : t));
  } catch {
    return [];
  }
}

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>(loadPersisted);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const retryHandlers = useRef<Map<string, () => void>>(new Map());

  const persist = useCallback((next: Task[]) => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* quota/privado — ignora */ }
  }, []);

  const addTask = useCallback((task: Omit<Task, "id" | "createdAt">): string => {
    const id = `task-${++_seq}`;
    setTasks((prev) => {
      const next = [{ ...task, id, createdAt: Date.now() }, ...prev];
      persist(next);
      return next;
    });
    return id;
  }, [persist]);

  const updateTask = useCallback((id: string, patch: Partial<Omit<Task, "id" | "createdAt">>) => {
    setTasks((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ...patch } : t));
      persist(next);
      return next;
    });
    // auto-remove done tasks after 10s
    if (patch.status === "done") {
      const timer = setTimeout(() => {
        setTasks((prev) => {
          const next = prev.filter((t) => t.id !== id);
          persist(next);
          return next;
        });
        timers.current.delete(id);
      }, 10_000);
      timers.current.set(id, timer);
    }
  }, [persist]);

  const removeTask = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setTasks((prev) => {
      const next = prev.filter((t) => t.id !== id);
      persist(next);
      return next;
    });
  }, [persist]);

  const clearDone = useCallback(() => {
    setTasks((prev) => {
      const next = prev.filter((t) => t.status !== "done");
      persist(next);
      return next;
    });
  }, [persist]);

  const registerRetry = useCallback((id: string, fn: () => void) => {
    retryHandlers.current.set(id, fn);
  }, []);

  const retry = useCallback((id: string) => {
    retryHandlers.current.get(id)?.();
  }, []);

  return (
    <Ctx.Provider value={{ tasks, addTask, updateTask, removeTask, clearDone, registerRetry, retry }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTaskCenter() {
  return useContext(Ctx);
}
