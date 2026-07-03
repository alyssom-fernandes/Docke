import { useRef, useState, useEffect, type ElementType } from "react";
import { Bell, Upload, FileSearch, Archive, Download, X, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useTaskCenter, type Task, type TaskKind } from "@/lib/TaskContext";
import api from "@/lib/api";
import { relativeDate } from "@/lib/date";

const KIND_ICON: Record<TaskKind, ElementType> = {
  upload: Upload,
  ocr: FileSearch,
  zip: Archive,
  export: Download,
};

interface Notification {
  id: string;
  type: string;
  message: string;
  read_at: string | null;
  created_at: string;
}

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
const POLL_INTERVAL_MS = 30_000;

export default function TaskCenter() {
  const { tasks, removeTask, clearDone } = useTaskCenter();
  const [open, setOpen] = useState(false);
  const [everSeen, setEverSeen] = useState(() => localStorage.getItem(SEEN_KEY) === "true");
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const running = tasks.filter((t) => t.status === "running").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const hasDone = tasks.some((t) => t.status === "done");

  function loadNotifications() {
    api.get("/notifications", { params: { limit: 15 } })
      .then((r) => {
        setNotifications(Array.isArray(r.data?.results) ? r.data.results : []);
        setUnreadCount(r.data?.unread_count ?? 0);
      })
      .catch(() => {});
  }

  useEffect(() => {
    loadNotifications();
    const id = setInterval(loadNotifications, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

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

  async function markAllRead() {
    try {
      await api.post("/notifications/mark-all-read");
      setNotifications((prev) => prev.map((n) => ({ ...n, read_at: new Date().toISOString() })));
      setUnreadCount(0);
    } catch {
      // silencioso — não é uma ação crítica
    }
  }

  const badgeCount = running + unreadCount;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={handleToggle}
        className="relative p-2 rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast"
        title="Central de tarefas e notificações — acompanhe uploads, processamentos e atividade"
        aria-label="Central de tarefas e notificações"
      >
        <Bell className="w-4 h-4" />
        {(badgeCount > 0 || failed > 0) && (
          <span className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full text-[10px] font-bold text-white flex items-center justify-center ${failed > 0 ? "bg-red-500" : "bg-teal-600"}`}>
            {failed > 0 ? failed : badgeCount}
          </span>
        )}
        {!everSeen && badgeCount === 0 && failed === 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-teal-600 ring-2 ring-[var(--bg-card)]" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div className="glass-panel glass-blur-strong relative w-[340px] absolute top-full right-0 mt-1 rounded-[14px] shadow-[0_20px_50px_rgba(0,0,0,0.5)] z-50 overflow-hidden max-h-[70vh] flex flex-col">
          {/* Seção "Em andamento" — some inteira quando não há nada rodando */}
          {tasks.length > 0 && (
            <>
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-default)] flex-shrink-0">
                <span className="text-xs font-medium text-[var(--text-primary)]">Em andamento</span>
                {hasDone && (
                  <button onClick={clearDone} className="text-xs text-[var(--text-secondary)] hover:text-teal-600 transition-colors duration-fast">
                    Limpar concluídos
                  </button>
                )}
              </div>
              <ul className="max-h-[200px] overflow-y-auto divide-y divide-[var(--border-default)] flex-shrink-0">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} onRemove={() => removeTask(task.id)} />
                ))}
              </ul>
            </>
          )}

          {/* Seção "Notificações" */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-default)] flex-shrink-0">
            <span className="text-xs font-medium text-[var(--text-primary)]">Notificações</span>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-[var(--text-secondary)] hover:text-teal-600 transition-colors duration-fast">
                Marcar todas como lidas
              </button>
            )}
          </div>

          {notifications.length === 0 ? (
            tasks.length === 0 && (
              <div className="flex flex-col items-center py-8 text-center flex-1">
                <Bell className="w-6 h-6 text-[var(--text-placeholder)] mb-2" />
                <p className="text-sm text-[var(--text-secondary)]">Nada por aqui ainda</p>
              </div>
            )
          ) : (
            <ul className="overflow-y-auto divide-y divide-[var(--border-default)]">
              {notifications.map((n) => (
                <li key={n.id} className={`px-4 py-3 ${!n.read_at ? "bg-teal-50/50 dark:bg-teal-900/10" : ""}`}>
                  <p className="text-sm text-[var(--text-primary)]">{n.message}</p>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{relativeDate(n.created_at)}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
