import { KeyboardEvent, useEffect, useMemo, useRef, useState, type ElementType } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  Search, FolderOpen, Folder, Upload, FolderPlus, LayoutDashboard, Anchor, Link2, Activity, CalendarClock, Trash2,
  Settings, Sun, Moon, Building2, Users, Archive, Tags, CornerDownLeft, Keyboard, WifiOff, Download, Copy, ChevronLeft, ChevronRight,
} from "lucide-react";
import { openKeyboardShortcuts } from "@/components/shared/KeyboardShortcuts";
import { getFileStyle } from "@/lib/fileType";
import { relativeDate } from "@/lib/date";
import api from "@/lib/api";
import { useCompany, useFeatures } from "@/lib/CompanyContext";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { toggleTheme } from "@/lib/theme";

interface QuickResult { id: string; name: string; type: "document" | "folder"; folder_id?: string | null }
interface DocumentPreview { id: string; name: string; size_bytes: number; ocr_excerpt?: string | null; ocr_text?: string | null; created_at: string }

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ElementType;
  iconClass?: string;
  keywords?: string;
  run: () => void;
  doc?: QuickResult;
}

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1).replace(".", ",")} KB` : `${(b / 1048576).toFixed(1).replace(".", ",")} MB`);
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** Filtro tolerante das ações do item: as letras na ordem, não precisam estar juntas ("bx" acha "Baixar"). */
const subseq = (q: string, t: string) => { let i = 0; for (const c of t) if (c === q[i]) i++; return i === q.length; };

/**
 * ⌘K como centro de comando (achados A2-20, A2-21): ações (enviar, nova
 * pasta, tema), ir para qualquer tela, trocar de empresa e achar documentos e
 * pastas, com a prévia ao lado da lista (largura fixa, sem salto). Padrão
 * combobox + listbox do WAI-ARIA: setas, Enter, Esc; o diálogo é modal.
 */
export default function CommandPalette() {
  const { isOpen, close } = useCommandPalette();
  const { current, companies, setCurrent } = useCompany() as ReturnType<typeof useCompany> & { companies: { id: string; name: string }[] };
  const recursos = useFeatures();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const cache = useRef(new Map<string, DocumentPreview>());
  // Sub-paleta (B2.1.3): Tab ou → sobre um documento ou pasta mostra as ações dele.
  const [acoesDe, setAcoesDe] = useState<QuickResult | null>(null);
  const queryPrincipal = useRef("");
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    setQuery(""); setResults([]); setActiveIdx(0); setPreview(null); setAcoesDe(null); setAviso(null);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => { window.clearTimeout(t); previousFocus.current?.focus?.(); };
  }, [isOpen]);

  useEffect(() => {
    if (acoesDe) return;
    if (!isOpen || !current || query.trim().length < 2) { setResults([]); setSearching(false); setSearchFailed(false); return; }
    setSearching(true);
    const t = window.setTimeout(() => {
      api.get<QuickResult[]>("/search/quick", { params: { q: query.trim(), company_id: current.id } })
        .then((r) => { setSearchFailed(false); setResults(Array.isArray(r.data) ? r.data.slice(0, 8) : []); })
        // Erro de rede não é "nada encontrado" (A2-22): a lista avisa.
        .catch(() => { setResults([]); setSearchFailed(true); })
        .finally(() => setSearching(false));
    }, 160);
    return () => window.clearTimeout(t);
  }, [query, isOpen, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function go(path: string) { close(); navigate(path); }

  function linkDe(r: QuickResult) {
    return r.type === "folder" ? `/documents?folder_id=${r.id}` : `/documents?folder_id=${r.folder_id ?? ""}&doc=${r.id}`;
  }
  function voltar() { setAcoesDe(null); setQuery(queryPrincipal.current); setAviso(null); }
  function abrirAcoes(r: QuickResult) { queryPrincipal.current = query; setAcoesDe(r); setQuery(""); setActiveIdx(0); setAviso(null); }

  const items: Item[] = useMemo(() => {
    if (acoesDe) {
      const r = acoesDe;
      const g = r.type === "folder" ? `Pasta: ${r.name}` : r.name;
      const acoes: Item[] = [
        { id: "x-abrir", group: g, label: r.type === "folder" ? "Abrir a pasta" : "Abrir", icon: FolderOpen, run: () => go(linkDe(r)) },
        ...(r.type === "document" ? [{ id: "x-baixar", group: g, label: "Baixar", icon: Download, keywords: "download", run: () => {
          api.get(`/documents/${r.id}/download-url`).then((x) => { const a = document.createElement("a"); a.href = x.data.download_url; a.download = r.name; a.click(); close(); })
            .catch(() => setAviso("Não foi possível baixar agora."));
        } } as Item] : []),
        { id: "x-ancorar", group: g, label: "Ancorar", icon: Anchor, keywords: "favorito fixar", run: () => {
          api.post("/favorites", r.type === "folder" ? { folder_id: r.id } : { document_id: r.id })
            .then(() => { setAviso("Ancorado."); }).catch((e) => setAviso(e?.response?.status === 409 ? "Já estava ancorado." : "Não foi possível ancorar."));
        } },
        { id: "x-link", group: g, label: "Copiar o link interno", icon: Copy, keywords: "copiar endereço url", run: () => {
          navigator.clipboard?.writeText(window.location.origin + linkDe(r)).then(() => setAviso("Link copiado: só quem tem acesso abre.")).catch(() => setAviso("Não foi possível copiar."));
        } },
        { id: "x-ativ", group: g, label: "Ver a atividade", icon: Activity, keywords: "histórico trilha quem", run: () => go(`/activity?item=${r.id}&nome=${encodeURIComponent(r.name)}`) },
        { id: "x-voltar", group: g, label: "Voltar aos resultados", icon: ChevronLeft, hint: "←", run: voltar },
      ];
      const q = fold(query.trim());
      return q ? acoes.filter((a) => subseq(q, fold(`${a.label} ${a.keywords ?? ""}`))) : acoes;
    }
    const dark = document.documentElement.classList.contains("dark");
    const base: Item[] = [
      { id: "a-enviar", group: "Ações", label: "Enviar documentos", icon: Upload, keywords: "upload subir arquivo", run: () => go("/documents?acao=enviar") },
      { id: "a-pasta", group: "Ações", label: "Nova pasta", icon: FolderPlus, keywords: "criar pasta", run: () => go("/documents?acao=nova-pasta") },
      { id: "a-tema", group: "Ações", label: dark ? "Usar o tema claro" : "Usar o tema escuro", hint: "Alt Shift D", icon: dark ? Sun : Moon, keywords: "tema escuro claro aparência", run: () => { toggleTheme(); close(); } },
      { id: "a-atalhos", group: "Ações", label: "Atalhos do teclado", hint: "?", icon: Keyboard, keywords: "teclas ajuda", run: () => { close(); openKeyboardShortcuts(); } },
      { id: "n-inicio", group: "Ir para", label: "Início", icon: LayoutDashboard, keywords: "painel dashboard", run: () => go("/dashboard") },
      { id: "n-docs", group: "Ir para", label: "Documentos", icon: FolderOpen, keywords: "pastas arquivos", run: () => go("/documents") },
      { id: "n-busca", group: "Ir para", label: "Busca", icon: Search, run: () => go("/search") },
      { id: "n-anc", group: "Ir para", label: "Ancorados", icon: Anchor, keywords: "favoritos", run: () => go("/favorites") },
      ...(recursos.links ? [{ id: "n-links", group: "Ir para", label: "Links", icon: Link2, keywords: "compartilhados compartilhar", run: () => go("/shares") }] : []),
      { id: "n-ativ", group: "Ir para", label: "Atividade", icon: Activity, keywords: "trilha auditoria histórico", run: () => go("/activity") },
      ...(recursos.obrigacoes ? [{ id: "n-obr", group: "Ir para", label: "Obrigações", icon: CalendarClock, keywords: "prazos vencimento", run: () => go("/obligations") }] : []),
      { id: "n-lix", group: "Ir para", label: "Lixeira", icon: Trash2, keywords: "excluídos restaurar", run: () => go("/trash") },
      { id: "n-usu", group: "Ir para", label: "Pessoas e acessos", icon: Users, keywords: "usuários permissões acesso membros", run: () => go("/settings/users") },
      { id: "n-meta", group: "Ir para", label: "Metadados", icon: Tags, keywords: "campos", run: () => go("/settings/metadata") },
      { id: "n-ret", group: "Ir para", label: "Retenção e descarte", icon: Archive, keywords: "legal hold bloqueio judicial prazo de guarda", run: () => go("/settings/retention") },
      { id: "n-aj", group: "Ir para", label: "Ajustes", icon: Settings, keywords: "configurações perfil senha", run: () => go("/settings/profile") },
    ];
    for (const c of companies ?? []) {
      if (c.id === current?.id) continue;
      base.push({ id: `e-${c.id}`, group: "Trocar de empresa", label: c.name, icon: Building2, keywords: "empresa", run: () => { setCurrent(c as never); close(); } });
    }
    const q = fold(query.trim());
    const filtered = q ? base.filter((i) => fold(`${i.label} ${i.keywords ?? ""}`).includes(q)) : base.filter((i) => i.group !== "Trocar de empresa" || (companies?.length ?? 0) <= 6);
    const found: Item[] = results.map((r) => {
      const st = r.type === "document" ? getFileStyle(r.name) : null;
      return {
        id: `r-${r.id}`, group: "Documentos e pastas", label: r.name, doc: r,
        icon: st ? st.icon : Folder, iconClass: st ? `${st.iconColor} ${st.fillColor}` : "text-(--text-accent)",
        hint: r.type === "folder" ? "Pasta" : "Documento",
        run: () => go(r.type === "folder" ? `/documents?folder_id=${r.id}` : `/documents?folder_id=${r.folder_id ?? ""}&doc=${r.id}`),
      };
    });
    const all = [...found, ...filtered];
    if (q.length >= 2) all.push({ id: "busca-total", group: "Busca", label: `Buscar "${query.trim()}" em todo o conteúdo`, icon: Search, run: () => go(`/search?q=${encodeURIComponent(query.trim())}`) });
    return all;
  }, [query, results, companies, current?.id, acoesDe, recursos.links, recursos.obrigacoes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActiveIdx(0); }, [query, results.length]);

  // Prévia do documento em foco (com cache).
  const active = items[activeIdx];
  useEffect(() => {
    const d = active?.doc;
    if (!d || d.type !== "document") { setPreview(null); return; }
    const hit = cache.current.get(d.id);
    if (hit) { setPreview(hit); return; }
    const t = window.setTimeout(() => {
      api.get<DocumentPreview>(`/documents/${d.id}`).then((r) => { cache.current.set(d.id, r.data); setPreview(r.data); }).catch(() => setPreview(null));
    }, 120);
    return () => window.clearTimeout(t);
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); items[activeIdx]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); if (acoesDe) voltar(); else close(); }
    else if ((e.key === "Tab" || (e.key === "ArrowRight" && (e.currentTarget as HTMLInputElement).selectionStart === query.length)) && !acoesDe && items[activeIdx]?.doc) {
      e.preventDefault(); abrirAcoes(items[activeIdx].doc!);
    }
    else if ((e.key === "ArrowLeft" || e.key === "Backspace") && acoesDe && !query) { e.preventDefault(); voltar(); }
    else if (e.key === "Tab") e.preventDefault();
  }

  if (!isOpen) return null;
  let lastGroup = "";

  return createPortal(
    <div className="fixed inset-0 z-[75]" data-no-inert>
      {/* Como o Spotlight: sem escurecer a janela; clicar fora fecha. */}
      <div aria-hidden className="absolute inset-0" onClick={close} />
      {/* No celular, tela cheia (A2-24); a partir de sm, a 16vh do topo, como o Spotlight. */}
      <div className="pointer-events-none absolute inset-0 sm:bottom-auto sm:top-[16vh] flex justify-center sm:px-3">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Comandos e busca rápida"
        className="dialog-panel-in pointer-events-auto w-full h-full sm:h-auto max-w-[760px] flex flex-col mac-sheet rounded-none sm:rounded-[26px] overflow-hidden pt-[env(safe-area-inset-top)] sm:pt-0"
      >
        <div className="flex items-center gap-3 px-5 border-b border-(--separator-subtle)">
          <Search className="w-5 h-5 text-(--text-secondary) shrink-0" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-lista"
            aria-activedescendant={active ? `cmdk-${active.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Digite um comando, uma tela ou o nome de um documento"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={acoesDe ? `Ações de “${acoesDe.name}”… (← volta)` : "Ações, telas, empresas ou documentos…"}
            className="flex-1 h-14 pointer-coarse:h-14 bg-transparent text-[20px] text-(--text-primary) placeholder:text-(--text-secondary) focus:outline-hidden"
          />
          <button type="button" onClick={close} className="sm:hidden -mr-2 min-h-11 px-3 text-mac-body font-medium text-(--text-accent)">Fechar</button>
        </div>
        <div className="flex flex-1 min-h-0 sm:flex-none sm:h-[min(60vh,440px)]">
          {/* Quantos resultados há, para o leitor de tela (X1-15). */}
          <p className="sr-only" aria-live="polite">{searching ? "Procurando…" : `${items.length} ${items.length === 1 ? "resultado" : "resultados"}`}</p>
          <ul ref={listRef} id="cmdk-lista" role="listbox" aria-label="Resultados" className="flex-1 min-w-0 overflow-y-auto p-2">
            {aviso && (
              <li role="status" className="mx-1 mb-1 rounded-(--radius-control) bg-(--bg-hover) px-3 py-2 text-mac-caption text-(--text-primary)">{aviso}</li>
            )}
            {searchFailed && !acoesDe && (
              <li role="alert" className="mx-1 mb-1 flex items-center gap-2 rounded-(--radius-control) bg-(--bg-hover) px-3 py-2 text-mac-caption text-(--text-warning)">
                <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> Não deu para buscar agora (sem conexão ou servidor fora). As ações abaixo funcionam.
              </li>
            )}
            {items.length === 0 && !searchFailed && (
              <li className="px-3 py-8 text-center text-mac-body text-(--text-secondary)" role="presentation">
                {searching ? "Procurando…" : "Nada com esse nome. Enter busca no conteúdo dos documentos."}
              </li>
            )}
            {items.map((it, idx) => {
              const header = it.group !== lastGroup ? it.group : null;
              lastGroup = it.group;
              const Icon = it.icon;
              return (
                <li key={it.id} role="presentation">
                  {header && <p className="px-3 pt-2.5 pb-1 text-[11px] font-bold text-(--text-secondary)" aria-hidden>{header}</p>}
                  <div
                    id={`cmdk-${it.id}`}
                    data-idx={idx}
                    role="option"
                    aria-selected={idx === activeIdx}
                    onMouseMove={() => setActiveIdx(idx)}
                    onClick={() => it.run()}
                    className={`flex items-center gap-2.5 h-8 pointer-coarse:h-11 px-2.5 rounded-(--radius-sm) cursor-default select-none ${idx === activeIdx ? "bg-(--selection-bg) text-(--selection-text)" : "text-(--text-primary)"}`}
                  >
                    <Icon className={`w-4 h-4 shrink-0 ${idx === activeIdx ? "text-white" : it.iconClass ?? "text-(--text-secondary)"}`} aria-hidden />
                    <span className="flex-1 truncate text-mac-body">{it.label}</span>
                    {it.hint && <span className={`text-mac-caption ${idx === activeIdx ? "text-white/80" : "text-(--text-secondary)"}`}>{it.hint}</span>}
                    {it.doc && idx === activeIdx && <span className="hidden sm:inline-flex items-center text-mac-caption text-white/80" title="Ações (Tab)">Tab <ChevronRight className="w-3 h-3" aria-hidden /></span>}
                    {idx === activeIdx && <CornerDownLeft className="w-3.5 h-3.5 text-white/80" aria-hidden />}
                  </div>
                </li>
              );
            })}
          </ul>
          <aside aria-label="Prévia" className="hidden md:flex w-[300px] shrink-0 flex-col border-l border-(--border-default) p-4">
            {preview && active?.doc?.id === preview.id ? (
              <div className="reveal space-y-2 min-h-0">
                <p className="text-mac-body font-semibold text-(--text-primary) break-words">{preview.name}</p>
                <p className="text-mac-caption text-(--text-secondary)">{fmtSize(preview.size_bytes)} · enviado {relativeDate(preview.created_at)}</p>
                <p className="text-mac-caption text-(--text-secondary) line-clamp-[12] whitespace-pre-line border-t border-(--border-default) pt-2">
                  {(preview.ocr_excerpt ?? preview.ocr_text ?? "").trim() ? (preview.ocr_excerpt ?? preview.ocr_text ?? "").slice(0, 600) : "Sem texto reconhecido neste documento."}
                </p>
              </div>
            ) : (
              <div className="m-auto text-center text-mac-caption text-(--text-secondary) space-y-1">
                <p>↑ ↓ para escolher, Enter para abrir.</p>
                <p>Tab ou → num documento ou pasta mostra as ações dele.</p>
                <p>Digite o nome de um documento para ver a prévia aqui.</p>
              </div>
            )}
          </aside>
        </div>
      </div>
      </div>
    </div>,
    document.body,
  );
}
