import { useEffect, useState, type ElementType } from "react";
import { Link, useNavigate } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { relativeDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import {
  FileText,
  FolderOpen,
  Anchor,
  Clock,
  ChevronRight,
  Upload,
  Eye,
  Move,
  Trash2,
  Download,
  RefreshCw,
} from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";
import { UploadsLineChart, FolderBarChart, type DailyUpload, type FolderBreakdown } from "@/components/dashboard/StatsCharts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Stats {
  total_documents: number;
  total_folders: number;
  total_favorites: number;
  recent_uploads: number;
  documents_today: number;
  refreshed_at: string | null;
}

interface RecentDoc {
  id: string;
  name: string;
  mime_type: string;
  created_at: string;
  folder_id: string | null;
}

interface Favorite {
  id: string;
  item_type: "document" | "folder";
  item_id: string;
  item_name: string;
}

interface ActivityEvent {
  id: string;
  action: string;
  item_type: string;
  item_id: string;
  item_name_snapshot: string;
  current_folder_id: string | null;
  user_name: string;
  created_at: string;
}

/** Mesma lógica de Activity.tsx — null quando o item não existe mais. */
function activityTarget(ev: ActivityEvent): string | null {
  if (ev.item_type === "folder") return `/documents?folder_id=${ev.item_id}`;
  if (ev.item_type === "document" && ev.current_folder_id) {
    return `/documents?folder_id=${ev.current_folder_id}&doc=${ev.item_id}`;
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const fmtDate = relativeDate;

function actionLabel(action: string) {
  const map: Record<string, string> = {
    upload: "enviou",
    view: "visualizou",
    move: "moveu",
    rename: "renomeou",
    delete: "excluiu",
    restore: "restaurou",
    download: "baixou",
    favorite: "ancorou",
    unfavorite: "desancorou",
    undo: "desfez",
    copy: "copiou a estrutura para",
    update_metadata: "atualizou um campo de",
  };
  return map[action] ?? action;
}

function actionIcon(action: string) {
  const map: Record<string, ElementType> = {
    upload: Upload,
    view: Eye,
    download: Download,
    move: Move,
    delete: Trash2,
    favorite: Anchor,
  };
  const Icon = map[action] ?? FileText;
  return <Icon className="w-3.5 h-3.5" />;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Fase 3.5: "número sempre com contexto" — nunca um total sozinho sem
// explicar se é muito, pouco, ou o de sempre.
function StatCard({ label, value, icon: Icon, color, context }: { label: string; value: number; icon: ElementType; color: string; context?: string }) {
  return (
    <div className="glass-panel glass-blur-card glass-highlight-line glass-interactive relative rounded-[var(--radius-panel)] p-5 flex items-center gap-3.5">
      <Icon className={`w-5 h-5 flex-shrink-0 ${color}`} strokeWidth={1.5} />
      <div>
        <p className="text-mac-title1 font-semibold text-[var(--text-primary)]">{value.toLocaleString("pt-BR")}</p>
        <p className="text-mac-caption text-[var(--text-secondary)] mt-0.5">{label}</p>
        {context && <p className="text-mac-caption2 text-teal-600 dark:text-teal-400 mt-0.5">{context}</p>}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  usePageTitle("Dashboard");
  const { current } = useCompany();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [dailyUploads, setDailyUploads] = useState<DailyUpload[]>([]);
  const [byFolder, setByFolder] = useState<FolderBreakdown[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Fase 3.3: cooldown de 15s no cliente espelha o cooldown por empresa que
  // o backend já impõe — evita bater a cara no 429 clicando repetido.
  const [refreshCooldown, setRefreshCooldown] = useState(0);

  const emptyStats: Stats = { total_documents: 0, total_folders: 0, total_favorites: 0, recent_uploads: 0, documents_today: 0, refreshed_at: null };

  useEffect(() => {
    if (!current) return;
    setLoading(true);

    Promise.all([
      api.get(`/companies/${current.id}/stats`).catch(() => ({ data: emptyStats })),
      api.get(`/companies/${current.id}/stats/charts`).catch(() => ({ data: { daily_uploads: [], by_folder: [] } })),
      api.get("/documents/recent", { params: { company_id: current.id, limit: 5 } }).catch(() => ({ data: [] })),
      api.get("/favorites").catch(() => ({ data: [] })),
      api.get("/activity", { params: { company_id: current.id, page_size: 8 } }).catch(() => ({ data: { results: [] } })),
    ]).then(([statsRes, chartsRes, recentRes, favsRes, actRes]) => {
      setStats(statsRes.data);
      setDailyUploads(Array.isArray(chartsRes.data?.daily_uploads) ? chartsRes.data.daily_uploads : []);
      setByFolder(Array.isArray(chartsRes.data?.by_folder) ? chartsRes.data.by_folder : []);
      setRecent(Array.isArray(recentRes.data) ? recentRes.data : []);
      setFavorites(Array.isArray(favsRes.data) ? favsRes.data : []);
      setActivity(Array.isArray(actRes.data) ? actRes.data : (actRes.data.results ?? []));
    }).finally(() => setLoading(false));
  }, [current?.id]);

  useEffect(() => {
    if (refreshCooldown <= 0) return;
    const id = setTimeout(() => setRefreshCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [refreshCooldown]);

  async function refreshStats() {
    if (!current || refreshing || refreshCooldown > 0) return;
    setRefreshing(true);
    try {
      const r = await api.post(`/companies/${current.id}/stats/refresh`);
      setStats(r.data);
      setRefreshCooldown(15);
    } catch {
      // 429 (cooldown do servidor) ou erro de rede — silencioso, o número
      // exibido continua o último válido, nada quebra visualmente.
    } finally {
      setRefreshing(false);
    }
  }

  if (!current) {
    return (
      <EmptyState
        title="Nenhuma empresa selecionada"
        description="Selecione uma empresa no topo para ver o painel."
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Fase 3.3: "atualizado há X" — o número vem de uma materialized view
          recalculada a cada 15min pelo worker; sem isso fica ambíguo se o
          usuário está vendo dado em tempo real ou não. */}
      {!loading && stats && (
        <div className="flex items-center justify-end gap-2 -mb-2">
          <span className="text-mac-caption text-[var(--text-tertiary)]">
            {stats.refreshed_at ? `Atualizado ${relativeDate(stats.refreshed_at)}` : "Atualizando…"}
          </span>
          <button
            onClick={refreshStats}
            disabled={refreshing || refreshCooldown > 0}
            className="flex items-center gap-1 text-mac-caption text-[var(--text-secondary)] hover:text-teal-500 disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} />
            {refreshCooldown > 0 ? `Aguarde ${refreshCooldown}s` : "Atualizar"}
          </button>
        </div>
      )}

      {/* Stats */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-panel)] p-5 h-[84px] animate-pulse" />
          ))}
        </div>
      ) : stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <StatCard
            label="Documentos" value={stats.total_documents} icon={FileText} color="text-teal-500 dark:text-teal-400"
            context={stats.documents_today > 0 ? `+${stats.documents_today} hoje` : undefined}
          />
          <StatCard label="Pastas" value={stats.total_folders} icon={FolderOpen} color="text-teal-500 dark:text-teal-400" />
          <StatCard label="Ancorados" value={stats.total_favorites} icon={Anchor} color="text-teal-500 dark:text-teal-400" />
          <StatCard
            label="Uploads recentes" value={stats.recent_uploads} icon={Clock} color="text-teal-500 dark:text-teal-400"
            context="últimos 7 dias"
          />
        </div>
      )}

      {/* Fase 3.2: os dois gráficos do dashboard — juntos, uma fração pequena
          da tela (regra "menos de 20% é gráfico" da pesquisa). */}
      {!loading && (dailyUploads.length > 0 || byFolder.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-5">
            <h2 className="text-mac-body font-semibold text-[var(--text-secondary)] mb-3">Uploads · últimos 14 dias</h2>
            <UploadsLineChart data={dailyUploads} />
          </div>
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-5">
            <h2 className="text-mac-body font-semibold text-[var(--text-secondary)] mb-3">Documentos por pasta</h2>
            <FolderBarChart data={byFolder} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Documentos recentes */}
        <div className="lg:col-span-2 glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-2 border-b border-[var(--border-default)]">
            <h2 className="text-mac-body font-semibold text-[var(--text-secondary)]">Documentos recentes</h2>
            <Link to="/documents" className="flex items-center gap-1 text-mac-caption text-[var(--text-secondary)] hover:text-teal-500">
              Ver todos <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          {loading ? (
            <div className="p-5 space-y-3">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-[var(--bg-hover)] rounded animate-pulse" />)}
            </div>
          ) : recent.length === 0 ? (
            <div className="py-8">
              <EmptyState title="Nenhum documento ainda" description="Faça upload do primeiro documento." icon={<FileText className="w-6 h-6" />} />
            </div>
          ) : (
            <ul>
              {recent.map((doc) => (
                <li
                  key={doc.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/documents?folder_id=${doc.folder_id ?? ""}&doc=${doc.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/documents?folder_id=${doc.folder_id ?? ""}&doc=${doc.id}`);
                    }
                  }}
                  className="flex items-center gap-3 px-5 py-2 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0 cursor-pointer"
                >
                  {(() => { const s = getFileStyle(doc.name); const Icon = s.icon; return (
                    <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.iconColor} ${s.fillColor}`} />
                    </div>
                  ); })()}
                  <span className="flex-1 text-mac-body text-[var(--text-primary)] truncate">{doc.name}</span>
                  <span className="text-mac-caption text-[var(--text-tertiary)] flex-shrink-0">{fmtDate(doc.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Favorites */}
        <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-2 border-b border-[var(--border-default)]">
            <h2 className="text-mac-body font-semibold text-[var(--text-secondary)]">Ancorados</h2>
            <Link to="/favorites" className="flex items-center gap-1 text-mac-caption text-[var(--text-secondary)] hover:text-teal-500">
              Ver todos <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          {loading ? (
            <div className="p-5 space-y-3">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-[var(--bg-hover)] rounded animate-pulse" />)}
            </div>
          ) : favorites.length === 0 ? (
            <div className="py-8">
              <EmptyState title="Nada ancorado ainda" description="Clique no ícone de âncora em qualquer documento ou pasta para fixá-lo aqui." icon={<Anchor className="w-6 h-6" />} />
            </div>
          ) : (
            <ul>
              {favorites.map((fav) => (
                <li key={fav.id} className="flex items-center gap-2 px-5 py-2 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0">
                  {fav.item_type === "folder" ? (
                    <FolderOpen className="w-4 h-4 text-teal-500 fill-teal-500/20 flex-shrink-0" />
                  ) : (
                    (() => { const s = getFileStyle(fav.item_name); const Icon = s.icon; return (
                      <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                        <Icon className={`w-3.5 h-3.5 ${s.iconColor} ${s.fillColor}`} />
                      </div>
                    ); })()
                  )}
                  <span className="flex-1 text-mac-body text-[var(--text-primary)] truncate">{fav.item_name}</span>
                  <Badge variant="default">{fav.item_type === "folder" ? "Pasta" : "Doc"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Activity feed */}
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-2 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-secondary)]">Atividade recente</h2>
          <Link to="/activity" className="flex items-center gap-1 text-mac-caption text-[var(--text-secondary)] hover:text-teal-500">
            Ver tudo <ChevronRight className="w-3 h-3" />
          </Link>
        </div>
        {loading ? (
          <div className="p-5 space-y-3">
            {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-[var(--bg-hover)] rounded animate-pulse" />)}
          </div>
        ) : activity.length === 0 ? (
          <div className="py-8">
            <EmptyState title="Nenhuma atividade" icon={<Clock className="w-6 h-6" />} />
          </div>
        ) : (
          <ul>
            {activity.map((ev) => {
              const target = activityTarget(ev);
              return (
                <li
                  key={ev.id}
                  role={target ? "button" : undefined}
                  tabIndex={target ? 0 : undefined}
                  onClick={target ? () => navigate(target) : undefined}
                  onKeyDown={
                    target
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(target);
                          }
                        }
                      : undefined
                  }
                  title={target ? undefined : "Item não está mais disponível"}
                  className={`flex items-center gap-3 px-5 py-2 transition-colors duration-fast border-b border-[var(--border-default)] last:border-0 ${
                    target ? "hover:bg-[var(--bg-hover)] cursor-pointer" : ""
                  }`}
                >
                  <Avatar name={ev.user_name} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-mac-body text-[var(--text-primary)] truncate">
                      <span className="font-medium">{ev.user_name}</span>{" "}
                      {actionLabel(ev.action)}{" "}
                      <span className="text-[var(--text-secondary)]">{ev.item_name_snapshot}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 text-[var(--text-tertiary)] flex-shrink-0">
                    {actionIcon(ev.action)}
                    <span className="text-mac-caption">{fmtDate(ev.created_at)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
