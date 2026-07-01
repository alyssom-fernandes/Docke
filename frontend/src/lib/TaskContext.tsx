import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

export type TaskStatus = "running" | "done" | "failed";
export type TaskKind = "upload" | "ocr" | "zip" | "export";

export interface Task {
  id: string;
  kind: TaskKind;
  label: string;
  status: TaskStatus;
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
}

const Ctx = createContext<TaskCtx>({
  tasks: [],
  addTask: () => "",
  updateTask: () => {},
  removeTask: () => {},
  clearDone: () => {},
});

let _seq = 0;

export function TaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const addTask = useCallback((task: Omit<Task, "id" | "createdAt">): string => {
    const id = `task-${++_seq}`;
    setTasks((prev) => [{ ...task, id, createdAt: Date.now() }, ...prev]);
    return id;
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<Omit<Task, "id" | "createdAt">>) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
    );
    // auto-remove done tasks after 10s
    if (patch.status === "done") {
      const timer = setTimeout(() => {
        setTasks((prev) => prev.filter((t) => t.id !== id));
        timers.current.delete(id);
      }, 10_000);
      timers.current.set(id, timer);
    }
  }, []);

  const removeTask = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearDone = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status !== "done"));
  }, []);

  return (
    <Ctx.Provider value={{ tasks, addTask, updateTask, removeTask, clearDone }}>
      {children}
    </Ctx.Provider>
  );
}

export function useTaskCenter() {
  return useContext(Ctx);
}
