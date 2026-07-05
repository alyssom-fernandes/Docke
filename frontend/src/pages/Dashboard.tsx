import { useEffect, useState, type ElementType } from "react";
import { Link } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { relativeDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import {
  FileText,
  FolderOpen,
  Anchor,
  Clock,
  ArrowRight,
  Upload,
  Eye,
  Move,
  Trash2,
  Download,
} from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Stats {
  total_documents: number;
  total_folders: number;
  total_favorites: number;
  recent_uploads: number;
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
  item_name_snapshot: string;
  user_name: string;
  created_at: string;
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

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: ElementType; color: string }) {
  return (
    <div className="glass-panel glass-blur-card glass-highlight-line glass-interactive relative rounded-[22px] p-5 flex items-center gap-4">
      <div className={`w-10 h-10 rounded-[10px] flex items-center justify-center flex-shrink-0 ${color}`}>
        <Icon className="w-5 h-5" />
      </div>
      <div>
        <p className="text-2xl font-semibold text-[var(--text-primary)]">{value.toLocaleString("pt-BR")}</p>
        <p className="text-xs text-[var(--text-secondary)]">{label}</p>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Dashboard() {
  usePageTitle("Dashboard");
  const { current } = useCompany();
  const [stats, setStats] = useState<Stats | null>(null);
  const [recent, setRecent] = useState<RecentDoc[]>([]);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!current) return;
    setLoading(true);

    Promise.all([
      api.get(`/companies/${current.id}/stats`).catch(() => ({ data: { total_documents: 0, total_folders: 0, total_favorites: 0, recent_uploads: 0 } })),
      api.get("/documents/recent", { params: { company_id: current.id, limit: 5 } }).catch(() => ({ data: [] })),
      api.get("/favorites").catch(() => ({ data: [] })),
      api.get("/activity", { params: { company_id: current.id, page_size: 8 } }).catch(() => ({ data: { results: [] } })),
    ]).then(([statsRes, recentRes, favsRes, actRes]) => {
      setStats(statsRes.data);
      setRecent(Array.isArray(recentRes.data) ? recentRes.data : []);
      setFavorites(Array.isArray(favsRes.data) ? favsRes.data : []);
      setActivity(Array.isArray(actRes.data) ? actRes.data : (actRes.data.results ?? []));
    }).finally(() => setLoading(false));
  }, [current?.id]);

  if (!current) {
    return (
      <EmptyState
        title="Nenhuma empresa selecionada"
        description="Selecione uma empresa no topo para ver o painel."
      />
    );
  }

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Painel</h1>
        <p className="text-sm text-[var(--text-secondary)]">{current.name}</p>
      </div>

      {/* Stats */}
      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[22px] p-5 h-[84px] animate-pulse" />
          ))}
        </div>
      ) : stats && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Documentos" value={stats.total_documents} icon={FileText} color="bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400" />
          <StatCard label="Pastas" value={stats.total_folders} icon={FolderOpen} color="bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400" />
          <StatCard label="Ancorados" value={stats.total_favorites} icon={Anchor} color="bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400" />
          <StatCard label="Uploads recentes" value={stats.recent_uploads} icon={Clock} color="bg-purple-50 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400" />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Documentos recentes */}
        <div className="lg:col-span-2 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Documentos recentes</h2>
            <Link to="/documents" className="flex items-center gap-1 text-xs text-teal-600 hover:underline">
              Ver todos <ArrowRight className="w-3 h-3" />
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
                <li key={doc.id} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0">
                  {(() => { const s = getFileStyle(doc.name); const Icon = s.icon; return (
                    <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.iconColor}`} />
                    </div>
                  ); })()}
                  <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{doc.name}</span>
                  <span className="text-xs text-[var(--text-tertiary)] flex-shrink-0">{fmtDate(doc.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Favorites */}
        <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
            <h2 className="text-sm font-medium text-[var(--text-primary)]">Ancorados</h2>
            <Link to="/favorites" className="flex items-center gap-1 text-xs text-teal-600 hover:underline">
              Ver todos <ArrowRight className="w-3 h-3" />
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
                <li key={fav.id} className="flex items-center gap-2 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0">
                  {fav.item_type === "folder" ? (
                    <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                  ) : (
                    (() => { const s = getFileStyle(fav.item_name); const Icon = s.icon; return (
                      <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                        <Icon className={`w-3.5 h-3.5 ${s.iconColor}`} />
                      </div>
                    ); })()
                  )}
                  <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{fav.item_name}</span>
                  <Badge variant="default">{fav.item_type === "folder" ? "Pasta" : "Doc"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Activity feed */}
      <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Atividade recente</h2>
          <Link to="/activity" className="flex items-center gap-1 text-xs text-teal-600 hover:underline">
            Ver tudo <ArrowRight className="w-3 h-3" />
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
            {activity.map((ev) => (
              <li key={ev.id} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0">
                <Avatar name={ev.user_name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[var(--text-primary)] truncate">
                    <span className="font-medium">{ev.user_name}</span>{" "}
                    {actionLabel(ev.action)}{" "}
                    <span className="text-[var(--text-secondary)]">{ev.item_name_snapshot}</span>
                  </p>
                </div>
                <div className="flex items-center gap-1.5 text-[var(--text-tertiary)] flex-shrink-0">
                  {actionIcon(ev.action)}
                  <span className="text-xs">{fmtDate(ev.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
