import { useRef, useState, useEffect, type ElementType } from "react";
import { ListTodo, Upload, FileSearch, Archive, Download, X, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useTaskCenter, type Task, type TaskKind } from "@/lib/TaskContext";

const KIND_ICON: Record<TaskKind, ElementType> = {
  upload: Upload,
  ocr: FileSearch,
  zip: Archive,
  export: Download,
};

function TaskRow({ task, onRemove }: { task: Task; onRemove: () => void }) {
  const Icon = KIND_ICON[task.kind];
  return (
    <li className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast group">
      <div className="flex-shrink-0">
        {task.status === "running" ? (
          <Loader2 className="w-4 h-4 text-teal-600 animate-spin" />
        ) : task.status === "done" ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        ) : (
          <AlertCircle className="w-4 h-4 text-red-500" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-[var(--text-primary)] truncate">{task.label}</p>
        {task.status === "running" && task.progress !== undefined && (
          <div className="mt-1 h-1 bg-[var(--bg-hover)] rounded-full overflow-hidden">
            <div
              className="h-full bg-teal-600 rounded-full transition-[width] duration-normal"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        )}
        {task.status === "running" && task.progress === undefined && (
          <div className="mt-1 h-1 bg-[var(--bg-hover)] rounded-full overflow-hidden">
            <div className="h-full w-1/3 bg-teal-600 rounded-full animate-pulse" />
          </div>
        )}
        {task.status === "failed" && task.error && (
          <p className="text-xs text-red-500 mt-0.5 truncate">{task.error}</p>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <Icon className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
        <button
          onClick={onRemove}
          className="opacity-0 group-hover:opacity-100 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-all duration-fast"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    </li>
  );
}

const SEEN_KEY = "docke_task_center_seen";

export default function TaskCenter() {
  const { tasks, removeTask, clearDone } = useTaskCenter();
  const [open, setOpen] = useState(false);
  const [everSeen, setEverSeen] = useState(() => localStorage.getItem(SEEN_KEY) === "true");
  const ref = useRef<HTMLDivElement>(null);

  const running = tasks.filter((t) => t.status === "running").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const hasDone = tasks.some((t) => t.status === "done");

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function handleToggle() {
    setOpen((v) => !v);
    if (!everSeen) {
      localStorage.setItem(SEEN_KEY, "true");
      setEverSeen(true);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={handleToggle}
        className="relative p-2 rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast"
        title="Central de tarefas — acompanhe uploads e processamentos"
        aria-label="Central de tarefas"
      >
        <ListTodo className="w-4 h-4" />
        {(running > 0 || failed > 0) && (
          <span className={`absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full text-[10px] font-bold text-white flex items-center justify-center ${failed > 0 ? "bg-red-500" : "bg-teal-600"}`}>
            {failed > 0 ? failed : running}
          </span>
        )}
        {!everSeen && running === 0 && failed === 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-teal-600 ring-2 ring-[var(--bg-card)]" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="absolute top-full right-0 mt-1 w-[320px] bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] shadow-dropdown z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-default)]">
            <span className="text-xs font-medium text-[var(--text-primary)]">Task Center</span>
            {hasDone && (
              <button onClick={clearDone} className="text-xs text-[var(--text-secondary)] hover:text-teal-600 transition-colors duration-fast">
                Limpar concluídos
              </button>
            )}
          </div>

          {tasks.length === 0 ? (
            <div className="flex flex-col items-center py-8 text-center">
              <ListTodo className="w-6 h-6 text-[var(--text-placeholder)] mb-2" />
              <p className="text-sm text-[var(--text-secondary)]">Nenhuma tarefa em andamento</p>
            </div>
          ) : (
            <ul className="max-h-[320px] overflow-y-auto divide-y divide-[var(--border-default)]">
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} onRemove={() => removeTask(task.id)} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
