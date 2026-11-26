import { useRef, useState, useEffect, useCallback, type ElementType } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, Upload, FileSearch, Archive, Download, X, CheckCircle2, AlertCircle, Loader2, RotateCcw, RefreshCw, ChevronRight } from "lucide-react";
import { useTaskCenter, type Task, type TaskKind } from "@/lib/TaskContext";
import { useCompany } from "@/lib/CompanyContext";
import api from "@/lib/api";
import { relativeDate, fullDate } from "@/lib/date";

const KIND_ICON: Record<TaskKind, ElementType> = {
  upload: Upload,
  ocr: FileSearch,
  zip: Archive,
  export: Download,
};

interface Notification {
  id: string;
  type: string;
  resource_type: string | null;
  resource_id: string | null;
  company_id?: string | null;
  folder_id?: string | null;
  in_trash?: boolean;
  message: string;
  read_at: string | null;
  created_at: string;
}

/** Para onde a notificação leva (A2-26). */
function notificationTarget(n: Notification): string | null {
  if (n.type === "trash_expiring" || n.in_trash) return "/trash";
  if (!n.resource_id) return null;
  if (n.resource_type === "folder") return `/documents?folder_id=${n.resource_id}`;
  if (n.resource_type === "document" && n.folder_id) return `/documents?folder_id=${n.folder_id}&doc=${n.resource_id}`;
  if (n.resource_type === "obligation_instance") return "/obligations";
  return null;
}

function TaskRow({ task, onRemove, onRetry, onCancel }: { task: Task; onRemove: () => void; onRetry: () => void; onCancel: () => void }) {
  // Estados separados na fila: o ícone reflete a fase real (subindo bytes ou
  // lendo o texto), não só um spinner igual para as duas etapas.
  const Icon = task.kind === "upload" && task.phase === "processing" ? FileSearch : KIND_ICON[task.kind];
  const estado = task.status === "running" ? "em andamento" : task.status === "done" ? "concluída" : "com falha";
  return (
    <li className="flex items-center gap-3 px-4 py-3 group" aria-label={`${task.label}, ${estado}`}>
      <div className="shrink-0" aria-hidden="true">
        {task.status === "running" ? (
          <Loader2 className="w-4 h-4 text-(--text-accent) animate-spin" />
        ) : task.status === "done" ? (
          <CheckCircle2 className="w-4 h-4 text-(--text-success)" />
        ) : (
          <AlertCircle className="w-4 h-4 text-(--text-danger)" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-mac-body text-(--text-primary) truncate" title={task.label}>{task.label}</p>
        {task.status === "running" && (
          <div className="mt-1 h-1 bg-(--bg-hover) rounded-full overflow-hidden" role="progressbar" aria-label={`Progresso de ${task.label}`}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress}>
            {task.progress !== undefined ? (
              <div className="h-full bg-teal-500 rounded-full transition-[width] duration-normal" style={{ width: `${task.progress}%` }} />
            ) : (
              <div className="h-full w-1/3 bg-teal-500 rounded-full animate-pulse" />
            )}
          </div>
        )}
        {task.status === "failed" && task.error && (
          <p className="text-mac-caption text-(--text-danger) mt-0.5">{task.error}</p>
        )}
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <Icon className="w-3.5 h-3.5 text-(--text-tertiary) mr-1" aria-hidden="true" />
        {task.status === "running" && task.cancellable && (
          <button onClick={onCancel} aria-label={`Cancelar ${task.label}`} title="Cancelar envio"
            className="w-7 h-7 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-danger) hover:bg-(--bg-hover) transition-colors duration-fast">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
        {/* Tentar de novo: só o envio sabe refazer com o arquivo original. */}
        {task.status === "failed" && task.kind === "upload" && (
          <button onClick={onRetry} aria-label={`Tentar enviar ${task.label} de novo`} title="Tentar de novo"
            className="w-7 h-7 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-accent) hover:bg-teal-500/10 transition-colors duration-fast">
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
        {task.status !== "running" && (
          <button onClick={onRemove} aria-label={`Tirar ${task.label} da lista`} title="Tirar da lista"
            className="w-7 h-7 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover) opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-all duration-fast">
            <X className="w-3 h-3" aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}

const SEEN_KEY = "docke_task_center_seen";
// Com a aba visível, confere a cada minuto; escondida, não consulta. Ao voltar
// para a aba e ao abrir o painel, atualiza na hora (A2-27).
const POLL_INTERVAL_MS = 60_000;

/**
 * Central de tarefas e avisos (A2-26..A2-29): "Em andamento" separado da
 * "Caixa de entrada"; cancelar envio; avisos levam ao item e marcam como
 * lidos; erro de rede visível com "Tentar de novo"; painel com semântica de
 * diálogo não modal, Esc devolve o foco ao sino.
 */
export default function TaskCenter() {
  const { tasks, removeTask, clearDone, retry, cancel } = useTaskCenter();
  const { current, companies, setCurrent } = useCompany() as ReturnType<typeof useCompany> & { companies: { id: string; name: string }[] };
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [everSeen, setEverSeen] = useState(() => localStorage.getItem(SEEN_KEY) === "true");
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const running = tasks.filter((t) => t.status === "running").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const hasDone = tasks.some((t) => t.status !== "running");

  const loadNotifications = useCallback(() => {
    setLoading(true);
    api.get("/notifications", { params: { limit: 30 } })
      .then((r) => {
        setNotifications(Array.isArray(r.data?.results) ? r.data.results : []);
        setUnreadCount(r.data?.unread_count ?? 0);
        setLoadFailed(false);
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadNotifications();
    const id = setInterval(() => { if (document.visibilityState === "visible") loadNotifications(); }, POLL_INTERVAL_MS);
    function onVisible() { if (document.visibilityState === "visible") loadNotifications(); }
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [loadNotifications]);

  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", onKey);
    window.setTimeout(() => panelRef.current?.focus(), 0);
    return () => { document.removeEventListener("mousedown", handle); document.removeEventListener("keydown", onKey); };
  }, [open]);

  function handleToggle() {
    setOpen((v) => {
      if (!v) loadNotifications();
      return !v;
    });
    if (!everSeen) {
      localStorage.setItem(SEEN_KEY, "true");
      setEverSeen(true);
    }
  }

  async function markAllRead() {
    const before = notifications;
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
    setUnreadCount(0);
    try {
      await api.post("/notifications/mark-all-read");
    } catch {
      setNotifications(before);
      setUnreadCount(before.filter((n) => !n.read_at).length);
    }
  }

  function openNotification(n: Notification) {
    const target = notificationTarget(n);
    if (!n.read_at) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
      setUnreadCount((c) => Math.max(0, c - 1));
      api.post(`/notifications/${n.id}/read`).catch(() => {});
    }
    if (!target) return;
    // O aviso pode ser de outra empresa: troca antes de abrir.
    if (n.company_id && n.company_id !== current?.id) {
      const other = companies?.find((c) => c.id === n.company_id);
      if (other) setCurrent(other as never);
    }
    setOpen(false);
    navigate(target);
  }

  const badgeCount = running + unreadCount;
  const resumo = [
    running ? `${running} em andamento` : "",
    failed ? `${failed} com falha` : "",
    unreadCount ? `${unreadCount} ${unreadCount === 1 ? "aviso não lido" : "avisos não lidos"}` : "",
  ].filter(Boolean).join(", ");

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? "central-tarefas" : undefined}
        className="relative w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) transition-colors duration-fast"
        title="Tarefas e avisos"
        aria-label={resumo ? `Tarefas e avisos: ${resumo}` : "Tarefas e avisos"}
      >
        <Bell className="w-4 h-4" aria-hidden="true" />
        {(badgeCount > 0 || failed > 0) && (
          <span aria-hidden="true" className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full text-[10px] font-bold text-white flex items-center justify-center ${failed > 0 ? "bg-red-600" : "bg-teal-600"}`}>
            {failed > 0 ? failed : badgeCount > 99 ? "99+" : badgeCount}
          </span>
        )}
        {!everSeen && badgeCount === 0 && failed === 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-teal-500 ring-2 ring-(--bg-card)" aria-hidden="true" />
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          id="central-tarefas"
          role="dialog"
          aria-label="Tarefas e avisos"
          tabIndex={-1}
          className="menu-in glass-dialog glass-blur-strong shadow-dropdown fixed left-3 right-3 top-[76px] sm:absolute sm:left-auto sm:right-0 sm:top-full sm:w-[360px] sm:mt-1.5 rounded-(--radius-popover) z-50 overflow-hidden max-h-[calc(100dvh-160px)] sm:max-h-[70vh] flex flex-col focus:outline-hidden"
          style={{ transformOrigin: "top right" }}
        >
          <div className="overflow-y-auto overscroll-contain">
            {/* Em andamento: some quando não há tarefa */}
            {tasks.length > 0 && (
              <section aria-labelledby="ct-andamento">
                <div className="sticky top-0 z-[1] glass-dialog flex items-center justify-between px-4 py-2.5 border-b border-(--border-default)">
                  <h2 id="ct-andamento" className="text-mac-caption font-semibold text-(--text-primary)">Em andamento</h2>
                  {hasDone && (
                    <button onClick={clearDone} className="text-mac-caption text-(--text-accent) hover:underline min-h-6 pointer-coarse:min-h-11">
                      Limpar concluídas
                    </button>
                  )}
                </div>
                <ul className="divide-y divide-(--border-default)">
                  {tasks.map((task) => (
                    <TaskRow key={task.id} task={task} onRemove={() => removeTask(task.id)} onRetry={() => retry(task.id)} onCancel={() => cancel(task.id)} />
                  ))}
                </ul>
              </section>
            )}

            <section aria-labelledby="ct-caixa">
              <div className="sticky top-0 z-[1] glass-dialog flex items-center justify-between px-4 py-2.5 border-y border-(--border-default) -mt-px">
                <h2 id="ct-caixa" className="text-mac-caption font-semibold text-(--text-primary)">
                  Caixa de entrada{unreadCount > 0 && <span className="font-normal text-(--text-secondary)"> · {unreadCount} não {unreadCount === 1 ? "lido" : "lidos"}</span>}
                </h2>
                {unreadCount > 0 && (
                  <button onClick={markAllRead} className="text-mac-caption text-(--text-accent) hover:underline min-h-6 pointer-coarse:min-h-11">
                    Marcar todos como lidos
                  </button>
                )}
              </div>

              {loadFailed && (
                <div role="alert" className="flex items-center gap-2 px-4 py-3 text-mac-caption text-(--text-warning)">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span className="flex-1">Não deu para carregar os avisos agora.</span>
                  <button onClick={loadNotifications} disabled={loading} className="inline-flex items-center gap-1 text-(--text-accent) font-medium hover:underline disabled:opacity-50 min-h-6 pointer-coarse:min-h-11">
                    <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} aria-hidden="true" /> Tentar de novo
                  </button>
                </div>
              )}

              {notifications.length === 0 ? (
                !loadFailed && (
                  <div className="flex flex-col items-center py-8 px-6 text-center">
                    <Bell className="w-6 h-6 text-(--text-tertiary) mb-2" aria-hidden="true" />
                    <p className="text-mac-body text-(--text-primary)">Nenhum aviso</p>
                    <p className="text-mac-caption text-(--text-secondary) mt-0.5">Envios, versões novas em itens que você acompanha, links acessados e prazos aparecem aqui.</p>
                  </div>
                )
              ) : (
                <ul className="divide-y divide-(--border-default)">
                  {notifications.map((n) => {
                    const target = notificationTarget(n);
                    const unread = !n.read_at;
                    return (
                      <li key={n.id}>
                        <button
                          type="button"
                          onClick={() => openNotification(n)}
                          className={`w-full text-left flex items-start gap-2.5 px-4 py-3 hover:bg-(--bg-hover) focus-visible:bg-(--bg-hover) focus-visible:outline-hidden transition-colors duration-fast ${unread ? "bg-teal-500/6" : ""}`}
                        >
                          <span aria-hidden="true" className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${unread ? "bg-teal-600" : "bg-transparent"}`} />
                          <span className="flex-1 min-w-0">
                            <span className="sr-only">{unread ? "Não lido: " : ""}</span>
                            <span className={`block text-mac-body text-(--text-primary) ${unread ? "font-medium" : ""}`}>{n.message}</span>
                            <time dateTime={n.created_at} title={fullDate(n.created_at)} className="block text-mac-caption text-(--text-secondary) mt-0.5">{relativeDate(n.created_at)}</time>
                          </span>
                          {target && <ChevronRight className="w-4 h-4 mt-0.5 text-(--text-tertiary) shrink-0" aria-hidden="true" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
