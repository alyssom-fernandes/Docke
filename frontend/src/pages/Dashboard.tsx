import { useEffect, useState, type ElementType, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  FileText, FolderOpen, Anchor, Upload, Download, RefreshCw, AlertTriangle, ChevronRight, SlidersHorizontal,
  ArrowUpRight, ArrowDownRight, Minus,
} from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { relativeDate, fullDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import EmptyState from "@/components/shared/EmptyState";
import ActivityFeed from "@/components/shared/ActivityFeed";
import TodayPanel from "@/components/dashboard/TodayPanel";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import {
  UploadsLineChart, FolderBarChart, FolderChartBreadcrumb,
  type DailyUpload, type FolderBreakdown, type FolderCrumb,
} from "@/components/dashboard/StatsCharts";

// ─── Período do gráfico de envios (fica por empresa, entre visitas) ──────────

const PERIOD_OPTIONS = [7, 14, 30, 90] as const;
type Period = (typeof PERIOD_OPTIONS)[number];
const periodKey = (companyId: string) => `docke_dashboard_period_${companyId}`;
function loadPeriod(companyId: string): Period {
  const n = Number(localStorage.getItem(periodKey(companyId)));
  return (PERIOD_OPTIONS as readonly number[]).includes(n) ? (n as Period) : 14;
}

// ─── Seções que cada pessoa pode esconder (achado A3-36) ─────────────────────

const SECTIONS = [
  { id: "numeros", label: "Números da empresa" },
  { id: "recentes", label: "Recentes e ancorados" },
  { id: "graficos", label: "Gráficos de envios e pastas" },
  { id: "atividade", label: "Atividade recente" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];
const hiddenKey = (userId: string) => `docke_inicio_ocultas_${userId}`;

// ─── Cache entre visitas (A3-09): mostra o último dado na hora e atualiza ───

const cache = new Map<string, unknown>();

type Load<T> = { status: "loading" | "ok" | "error"; data?: T; reload: () => void; refreshing: boolean };

/**
 * Carrega uma seção com estado próprio: erro é erro, vazio é vazio (A3-03).
 * `keepPrevious`: ao trocar o filtro, o dado anterior fica na tela (esmaecido)
 * até o novo chegar, em vez de piscar o esqueleto (gráficos, A3-18).
 */
function useSection<T>(key: string | null, fetcher: () => Promise<T>, keepPrevious = false): Load<T> {
  type S = { key: string | null; status: "loading" | "ok" | "error"; data?: T; refreshing: boolean };
  const [state, setState] = useState<S>(() => {
    const c = key ? (cache.get(key) as T | undefined) : undefined;
    return c !== undefined ? { key, status: "ok", data: c, refreshing: true } : { key, status: "loading", refreshing: false };
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const c = cache.get(key) as T | undefined;
    setState((s) => {
      if (c !== undefined) return { key, status: "ok", data: c, refreshing: true };
      if (s.data !== undefined && (s.key === key || keepPrevious)) return { ...s, key, refreshing: true };
      return { key, status: "loading", refreshing: false };
    });
    fetcher()
      .then((d) => { if (!alive) return; cache.set(key, d); setState({ key, status: "ok", data: d, refreshing: false }); })
      .catch(() => {
        if (!alive) return;
        // Com dado da mesma chave já na tela, mantém (é real, só não foi renovado).
        setState((s) => (s.data !== undefined && cache.has(key) ? { ...s, refreshing: false } : { key, status: "error", refreshing: false }));
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);
  return { status: state.status, data: state.data, refreshing: state.refreshing, reload: () => setNonce((n) => n + 1) };
}

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface Stats {
  total_documents: number;
  total_folders: number;
  total_favorites: number;
  recent_uploads: number;
  previous_uploads?: number;
  documents_today: number;
  refreshed_at: string | null;
}

interface RecentDoc {
  id: string;
  name: string;
  folder_id: string | null;
  folder_name?: string | null;
  ocr_status?: string;
  created_at: string;
  opened_at?: string;
}

interface Favorite {
  id: string;
  item_type: "document" | "folder";
  document_id: string | null;
  folder_id: string | null;
  document_folder_id: string | null;
  item_name: string;
}

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;

// ─── Peças ───────────────────────────────────────────────────────────────────

function SectionError({ what, onRetry, className = "" }: { what: string; onRetry: () => void; className?: string }) {
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-3 px-5 py-4 ${className}`}>
      <AlertTriangle className="w-4 h-4 text-(--text-warning) shrink-0" aria-hidden="true" />
      <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar {what}. Os dados continuam guardados.</p>
      <button onClick={onRetry} className="inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)">
        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo
      </button>
    </div>
  );
}

function Panel({ id, title, action, children, className = "" }: { id: string; title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={`glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-2 px-5 min-h-11 border-b border-(--border-default)">
        <h2 id={id} className="text-mac-body font-semibold text-(--text-primary)">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function SeeAll({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 min-h-8 pointer-coarse:min-h-11 text-mac-caption font-medium text-(--text-accent) hover:underline underline-offset-2 rounded-[6px] focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
      {children} <ChevronRight className="w-3 h-3" aria-hidden="true" />
    </Link>
  );
}

function RowsSkeleton({ n, h = "h-11" }: { n: number; h?: string }) {
  return (
    <div className="px-5 py-2 space-y-1" aria-label="Carregando">
      {Array.from({ length: n }, (_, i) => <div key={i} className={`${h} rounded-(--radius-control) bg-(--bg-hover) animate-pulse`} />)}
    </div>
  );
}

function FileBadge({ name }: { name: string }) {
  const s = getFileStyle(name);
  const Icon = s.icon;
  return (
    <span className={`w-7 h-7 rounded-badge flex items-center justify-center shrink-0 ${s.bgColor}`} aria-hidden="true">
      <Icon className={`w-4 h-4 ${s.iconColor} ${s.fillColor}`} />
    </span>
  );
}

/**
 * Contador clicável e com contexto (A3-11, A3-15): leva à lista que ele conta
 * e diz se a semana foi maior ou menor que a anterior. Mesma altura no
 * esqueleto e no cartão pronto, para a tela não pular (A3-04).
 */
function StatCard({ to, label, value, icon: Icon, context, trend, ariaLabel }: {
  to: string; label: string; value: number; icon: ElementType; context?: string; trend?: "up" | "down" | "same"; ariaLabel: string;
}) {
  const TrendIcon = trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : Minus;
  return (
    <Link
      to={to}
      aria-label={ariaLabel}
      className="glass-panel glass-blur-card glass-highlight-line glass-interactive rounded-(--radius-panel) px-2.5 py-2.5 sm:p-4 min-h-[68px] sm:min-h-[96px] flex items-start gap-3 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
    >
      <Icon className="hidden sm:block w-5 h-5 shrink-0 mt-1 text-(--text-accent)" strokeWidth={1.5} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-mac-title3 sm:text-mac-title1 font-semibold text-(--text-primary) tabular-nums">{value.toLocaleString("pt-BR")}</span>
        <span className="block text-mac-caption2 sm:text-mac-caption text-(--text-secondary) leading-tight">{label}</span>
        {context && (
          <span className="mt-0.5 hidden sm:flex items-center gap-1 text-mac-caption text-(--text-accent)">
            {trend && <TrendIcon className="w-3 h-3 shrink-0" aria-hidden="true" />}
            <span className="truncate">{context}</span>
          </span>
        )}
      </span>
    </Link>
  );
}

// ─── Página ──────────────────────────────────────────────────────────────────

export default function Dashboard() {
  usePageTitle("Início");
  const { current } = useCompany();
  const { user } = useAuthContext();
  const { error: showError, success } = useToast();
  const cid = current?.id ?? null;

  const [hidden, setHidden] = useState<SectionId[]>([]);
  const [customizing, setCustomizing] = useState(false);
  useEffect(() => {
    if (!user) return;
    try { setHidden(JSON.parse(localStorage.getItem(hiddenKey(user.id)) ?? "[]")); } catch { setHidden([]); }
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const shows = (id: SectionId) => !hidden.includes(id);

  const [period, setPeriod] = useState<Period>(14);
  const [folderPath, setFolderPath] = useState<FolderCrumb[]>([{ id: null, name: "Todas as pastas" }]);
  useEffect(() => {
    if (!cid) return;
    setPeriod(loadPeriod(cid));
    setFolderPath([{ id: null, name: "Todas as pastas" }]);
  }, [cid]);
  const folderId = folderPath[folderPath.length - 1].id;

  const [recentTab, setRecentTab] = useState<"abertos" | "enviados">(() => (localStorage.getItem("docke_inicio_recentes") === "abertos" ? "abertos" : "enviados"));
  const [activityKey, setActivityKey] = useState(0);

  const stats = useSection<Stats>(cid && `${cid}:stats`, () => api.get(`/companies/${cid}/stats`).then((r) => r.data));
  const recent = useSection<RecentDoc[]>(cid && `${cid}:recent:${recentTab}`, () =>
    api.get("/documents/recent", { params: { company_id: cid, limit: 6, mine: recentTab === "abertos" || undefined } }).then((r) => (Array.isArray(r.data) ? r.data : [])),
  );
  const favorites = useSection<Favorite[]>(cid && `${cid}:favorites`, () =>
    api.get("/favorites", { params: { company_id: cid } }).then((r) => (Array.isArray(r.data) ? r.data : [])),
  );
  // Período e pasta são filtros independentes: trocar um não refaz o outro (A3-18).
  const daily = useSection<DailyUpload[]>(cid && shows("graficos") ? `${cid}:daily:${period}` : null, () =>
    api.get(`/companies/${cid}/stats/charts`, { params: { days: period, only: "daily" } }).then((r) => r.data?.daily_uploads ?? []), true,
  );
  const byFolder = useSection<FolderBreakdown[]>(cid && shows("graficos") ? `${cid}:folders:${folderId ?? "raiz"}` : null, () =>
    api.get(`/companies/${cid}/stats/charts`, { params: { only: "folders", ...(folderId ? { folder_id: folderId } : {}) } }).then((r) => r.data?.by_folder ?? []), true,
  );

  // Atualizar sob demanda, com o motivo quando não dá (A3-13).
  const [refreshing, setRefreshing] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  async function refreshAll() {
    if (!cid || refreshing || cooldown > 0) return;
    setRefreshing(true);
    try {
      await api.post(`/companies/${cid}/stats/refresh`);
      stats.reload(); recent.reload(); favorites.reload(); daily.reload(); byFolder.reload();
      setActivityKey((k) => k + 1);
      setCooldown(15);
    } catch (e: any) {
      if (e?.response?.status === 429) { setCooldown(15); showError("Os números foram atualizados há poucos segundos. Tente de novo em instantes."); }
      else showError("Não foi possível atualizar agora. Confira a conexão e tente de novo.");
    } finally {
      setRefreshing(false);
    }
  }

  // Volta a olhar a atividade quando a aba volta a ficar visível (A3-31).
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") setActivityKey((k) => k + 1); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  function changePeriod(p: Period) {
    setPeriod(p);
    if (cid) localStorage.setItem(periodKey(cid), String(p));
  }

  // Um arquivo só, com as duas tabelas e o contexto (A3-22).
  function exportCsv() {
    if (!current) return;
    const now = new Date();
    const q = (c: string) => `"${c.replace(/"/g, '""')}"`;
    const lines = [
      `# Empresa: ${current.name}`,
      `# Gerado em: ${now.toLocaleString("pt-BR")}${user ? ` por ${user.full_name}` : ""}`,
      "",
      `# Envios por dia (últimos ${period} dias)`,
      "data,documentos_enviados",
      ...(daily.data ?? []).map((d) => `${d.date},${d.count}`),
      "",
      `# Documentos por pasta (${folderPath.map((c) => c.name).join(" > ")}; inclui subpastas)`,
      "pasta,documentos",
      ...(byFolder.data ?? []).map((f) => `${q(f.name)},${f.document_count}`),
    ];
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inicio-${current.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${now.toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    success("CSV gerado com os dois gráficos.");
  }

  if (!current) {
    return <EmptyState title="Nenhuma empresa selecionada" description="Escolha uma empresa no topo para ver o Início." />;
  }

  const s = stats.data;
  const prev = s?.previous_uploads;
  const trend: "up" | "down" | "same" | undefined = s && prev !== undefined ? (s.recent_uploads > prev ? "up" : s.recent_uploads < prev ? "down" : "same") : undefined;
  const trendText = s && prev !== undefined
    ? s.recent_uploads === prev ? "igual à semana anterior" : `${Math.abs(s.recent_uploads - prev).toLocaleString("pt-BR")} ${s.recent_uploads > prev ? "a mais" : "a menos"} que a anterior`
    : undefined;
  const favs = favorites.data ?? [];
  const FAV_LIMIT = 6;
  const totalDaily = (daily.data ?? []).reduce((a, d) => a + d.count, 0);

  return (
    <div className="flex flex-col gap-5 sm:gap-6 max-w-[1440px] w-full mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <div>
          <h1 className="text-mac-title2 font-semibold text-(--text-primary)">Início</h1>
          <p className="text-mac-caption text-(--text-secondary)">{current.name}</p>
        </div>
        <div className="flex items-center gap-1">
          {s && (
            <span className="hidden sm:inline text-mac-caption text-(--text-secondary) mr-1" title={s.refreshed_at ? fullDate(s.refreshed_at) : undefined}>
              {s.refreshed_at ? `Atualizado ${relativeDate(s.refreshed_at)}` : "Números ao vivo"}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={refreshAll} disabled={refreshing || cooldown > 0} aria-label="Atualizar o Início">
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} aria-hidden="true" />
            {cooldown > 0 ? `Aguarde ${cooldown}s` : "Atualizar"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setCustomizing(true)}>
            <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" /> Personalizar
          </Button>
        </div>
      </div>

      {/* 1. O que fazer hoje — primeira coisa da tela (A3-01, A3-02). */}
      <TodayPanel />

      {/* 2. Números, cada um leva à lista que conta. */}
      {shows("numeros") && (
        stats.status === "error" ? (
          <div className="glass-panel glass-blur-card rounded-(--radius-panel)"><SectionError what="os números da empresa" onRetry={stats.reload} /></div>
        ) : !s ? (
          <div className="grid grid-cols-4 gap-2 sm:gap-5" aria-label="Carregando os números">
            {[0, 1, 2, 3].map((i) => <div key={i} className="min-h-[68px] sm:min-h-[96px] rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" />)}
          </div>
        ) : (
          <section aria-label="Números da empresa" className="grid grid-cols-4 gap-2 sm:gap-5">
            <StatCard
              to="/documents" label="Documentos" value={s.total_documents} icon={FileText}
              context={s.documents_today > 0 ? `+${s.documents_today.toLocaleString("pt-BR")} hoje` : "nenhum envio hoje"}
              ariaLabel={`${plural(s.total_documents, "documento", "documentos")}, ${s.documents_today} enviados hoje. Abrir Documentos`}
            />
            <StatCard to="/documents" label="Pastas" value={s.total_folders} icon={FolderOpen} ariaLabel={`${plural(s.total_folders, "pasta", "pastas")}. Abrir Documentos`} />
            <StatCard to="/favorites" label="Ancorados por você" value={s.total_favorites} icon={Anchor} ariaLabel={`${plural(s.total_favorites, "item ancorado", "itens ancorados")}. Abrir Ancorados`} />
            <StatCard
              to="/activity?acao=upload" label="Enviados em 7 dias" value={s.recent_uploads} icon={Upload} trend={trend} context={trendText}
              ariaLabel={`${plural(s.recent_uploads, "documento enviado", "documentos enviados")} nos últimos 7 dias${trendText ? `, ${trendText}` : ""}. Ver na Atividade`}
            />
          </section>
        )
      )}

      {/* 3. Recentes e ancorados (antes dos gráficos: lista acionável primeiro). */}
      {shows("recentes") && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 sm:gap-6">
          <Panel
            id="inicio-recentes" title="Recentes" className="lg:col-span-2"
            action={
              <div role="tablist" aria-label="Quais recentes" className="flex items-center gap-0.5 p-0.5 rounded-full bg-(--bg-hover)">
                {([["abertos", "Abertos por você", "Abertos"], ["enviados", "Enviados na empresa", "Enviados"]] as const).map(([v, label, curto]) => (
                  <button
                    key={v} role="tab" aria-selected={recentTab === v}
                    onClick={() => { setRecentTab(v); localStorage.setItem("docke_inicio_recentes", v); }}
                    className={`px-2.5 h-7 pointer-coarse:h-10 rounded-full text-mac-caption font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${recentTab === v ? "bg-(--bg-card) text-(--text-primary) shadow-sm" : "text-(--text-secondary) hover:text-(--text-primary)"}`}
                  >
                    <span className="sm:hidden">{curto}</span><span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>
            }
          >
            {recent.status === "error" ? (
              <SectionError what="os documentos recentes" onRetry={recent.reload} />
            ) : !recent.data ? (
              <RowsSkeleton n={6} />
            ) : recent.data.length === 0 ? (
              recentTab === "abertos" ? (
                <p className="px-5 py-6 text-mac-body text-(--text-secondary)">Os documentos que você abrir ou baixar aparecem aqui, para voltar a eles num clique.</p>
              ) : (
                <div className="px-5 py-6 flex flex-wrap items-center gap-3">
                  <p className="flex-1 text-mac-body text-(--text-secondary)">Nenhum documento nesta empresa ainda.</p>
                  <Link to="/documents?acao=enviar" className="inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-4 rounded-full bg-teal-600 text-white text-mac-body font-medium hover:bg-teal-700">
                    <Upload className="w-3.5 h-3.5" aria-hidden="true" /> Enviar documentos
                  </Link>
                </div>
              )
            ) : (
              <ul role="tabpanel" aria-label={recentTab === "abertos" ? "Abertos por você" : "Enviados na empresa"}>
                {recent.data.map((doc) => (
                  <li key={doc.id} className="border-b border-(--border-default) last:border-0">
                    <Link
                      to={`/documents?folder_id=${doc.folder_id ?? ""}&doc=${doc.id}`}
                      className="flex items-center gap-3 px-5 py-2 min-h-12 hover:bg-(--bg-hover) transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)"
                    >
                      <FileBadge name={doc.name} />
                      <span className="flex-1 min-w-0">
                        <span className="block text-mac-body text-(--text-primary) truncate">{doc.name}</span>
                        <span className="block text-mac-caption text-(--text-secondary) truncate">
                          {doc.folder_name ?? "Sem pasta"}
                          {doc.ocr_status === "failed" && " · texto não lido"}
                          {(doc.ocr_status === "pending" || doc.ocr_status === "processing") && " · lendo o texto"}
                        </span>
                      </span>
                      <time dateTime={doc.opened_at ?? doc.created_at} className="text-mac-caption text-(--text-secondary) shrink-0" title={fullDate(doc.opened_at ?? doc.created_at)}>
                        {relativeDate(doc.opened_at ?? doc.created_at)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel id="inicio-ancorados" title="Ancorados" action={favs.length > 0 ? <SeeAll to="/favorites">Ver todos</SeeAll> : undefined}>
            {favorites.status === "error" ? (
              <SectionError what="os ancorados" onRetry={favorites.reload} />
            ) : !favorites.data ? (
              <RowsSkeleton n={4} />
            ) : favs.length === 0 ? (
              <p className="px-5 py-6 text-mac-body text-(--text-secondary) flex items-start gap-2">
                <Anchor className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                Ancore as pastas e documentos que você usa todo dia (ícone de âncora no menu do item) para chegar a eles daqui.
              </p>
            ) : (
              <>
                <ul>
                  {favs.slice(0, FAV_LIMIT).map((fav) => {
                    const to = fav.item_type === "folder"
                      ? `/documents?folder_id=${fav.folder_id}`
                      : `/documents?folder_id=${fav.document_folder_id ?? ""}&doc=${fav.document_id}`;
                    return (
                      <li key={fav.id} className="border-b border-(--border-default) last:border-0">
                        <Link to={to} className="flex items-center gap-3 px-5 py-2 min-h-11 hover:bg-(--bg-hover) transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                          {fav.item_type === "folder" ? (
                            <span className="w-7 h-7 flex items-center justify-center shrink-0" aria-hidden="true"><FolderOpen className="w-4.5 h-4.5 text-teal-600 dark:text-teal-400" /></span>
                          ) : (
                            <FileBadge name={fav.item_name} />
                          )}
                          <span className="flex-1 min-w-0 text-mac-body text-(--text-primary) truncate">{fav.item_name}</span>
                          <span className="text-mac-caption text-(--text-secondary) shrink-0">{fav.item_type === "folder" ? "Pasta" : "Documento"}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
                {favs.length > FAV_LIMIT && (
                  <div className="px-5 py-2 border-t border-(--border-default)">
                    <SeeAll to="/favorites">e mais {favs.length - FAV_LIMIT}</SeeAll>
                  </div>
                )}
              </>
            )}
          </Panel>
        </div>
      )}

      {/* 4. Gráficos: cada um com o próprio filtro dentro do cartão (A3-22). */}
      {shows("graficos") && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 sm:gap-6">
          <Panel
            id="inicio-envios" title="Envios por dia"
            action={
              <div className="flex items-center gap-2">
                <div role="radiogroup" aria-label="Período do gráfico de envios" className="flex items-center gap-0.5 p-0.5 rounded-full bg-(--bg-hover)">
                  {PERIOD_OPTIONS.map((p) => (
                    <button
                      key={p} role="radio" aria-checked={period === p} onClick={() => changePeriod(p)}
                      className={`px-2 h-6 pointer-coarse:h-9 rounded-full text-mac-caption font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${period === p ? "bg-teal-600 text-white" : "text-(--text-secondary) hover:text-(--text-primary)"}`}
                    >
                      {p}d
                    </button>
                  ))}
                </div>
              </div>
            }
          >
            <div className="p-5 min-h-[168px]">
              {daily.status === "error" ? (
                <SectionError what="o gráfico de envios" onRetry={daily.reload} className="px-0 py-0" />
              ) : !daily.data ? (
                <div className="h-[128px] rounded bg-(--bg-hover) animate-pulse" aria-label="Carregando o gráfico" />
              ) : (
                <div className={`transition-opacity duration-fast ${daily.refreshing ? "opacity-60" : ""}`}>
                  <p className="text-mac-caption text-(--text-secondary) mb-2">
                    {totalDaily === 0 ? `Nenhum envio nos últimos ${period} dias.` : `${plural(totalDaily, "documento enviado", "documentos enviados")} nos últimos ${period} dias`}
                  </p>
                  <UploadsLineChart data={daily.data} />
                </div>
              )}
            </div>
          </Panel>

          <Panel
            id="inicio-pastas" title="Documentos por pasta"
            action={(daily.data?.length || byFolder.data?.length) ? (
              <button onClick={exportCsv} className="inline-flex items-center gap-1 min-h-8 pointer-coarse:min-h-11 px-1 text-mac-caption font-medium text-(--text-accent) hover:underline rounded-[6px] focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
                <Download className="w-3 h-3" aria-hidden="true" /> Exportar CSV
              </button>
            ) : undefined}
          >
            <div className="p-5 min-h-[168px] space-y-3">
              {folderPath.length > 1 && <FolderChartBreadcrumb path={folderPath} onNavigate={(i) => setFolderPath((p) => p.slice(0, i + 1))} />}
              {byFolder.status === "error" ? (
                <SectionError what="o gráfico de pastas" onRetry={byFolder.reload} className="px-0 py-0" />
              ) : !byFolder.data ? (
                <div className="h-[128px] rounded bg-(--bg-hover) animate-pulse" aria-label="Carregando o gráfico" />
              ) : byFolder.data.length === 0 ? (
                <p className="text-mac-body text-(--text-secondary)">{folderPath.length > 1 ? "Nenhum documento dentro desta pasta." : "Nenhum documento nas pastas ainda."}</p>
              ) : (
                <div className={`transition-opacity duration-fast ${byFolder.refreshing ? "opacity-60" : ""}`}>
                  <FolderBarChart data={byFolder.data} onDrill={(id, name) => setFolderPath((p) => [...p, { id, name }])} />
                  <p className="mt-2 text-mac-caption text-(--text-secondary)">Cada barra soma a pasta e as subpastas.</p>
                </div>
              )}
            </div>
          </Panel>
        </div>
      )}

      {/* 5. Atividade (sem aberturas e downloads, que viram ruído aqui). */}
      {shows("atividade") && (
        <Panel id="inicio-atividade" title="Atividade recente" action={<SeeAll to="/activity">Ver tudo</SeeAll>}>
          <ActivityFeed
            companyId={current.id} pageSize={10} groupByDay={false} embedded refreshKey={activityKey}
            filters={{ semAcessos: true }} emptyDescription="Nenhuma alteração registrada ainda nesta empresa."
          />
        </Panel>
      )}

      {customizing && (
        <Dialog
          onClose={() => setCustomizing(false)}
          title="Personalizar o Início"
          description="Escolha o que aparece para você. O quadro “Para hoje” fica sempre visível."
          size="sm"
          footer={<Button onClick={() => setCustomizing(false)}>Pronto</Button>}
        >
          <ul className="space-y-1">
            {SECTIONS.map((sec) => {
              const checked = !hidden.includes(sec.id);
              return (
                <li key={sec.id}>
                  <label className="flex items-center gap-3 min-h-10 pointer-coarse:min-h-11 cursor-pointer text-mac-body text-(--text-primary)">
                    <Checkbox
                      checked={checked}
                      onChange={() => {
                        const next = checked ? [...hidden, sec.id] : hidden.filter((h) => h !== sec.id);
                        setHidden(next);
                        if (user) localStorage.setItem(hiddenKey(user.id), JSON.stringify(next));
                      }}
                    />
                    {sec.label}
                  </label>
                </li>
              );
            })}
          </ul>
        </Dialog>
      )}
    </div>
  );
}
