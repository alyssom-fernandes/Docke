import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Building2, ChevronsUpDown, Check, Search } from "lucide-react";
import { useCompany } from "@/lib/CompanyContext";

const RECENT_KEY = "docke_empresas_recentes";
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); } catch { return []; }
}

/**
 * Seletor de empresa (A2-08, A2-09, A2-11): botão com aria-expanded e
 * listbox; com mais de 5 empresas aparece a busca (sem acento); as 3 usadas
 * por último ficam no topo; setas, Home/End, Enter e Esc. Sem empresa
 * liberada, diz isso em vez de sumir.
 */
export default function CompanySwitcher() {
  const { companies, current, setCurrent } = useCompany();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const withSearch = companies.length > 5;

  const options = useMemo(() => {
    const q = fold(query.trim());
    if (q) return companies.filter((c) => fold(c.name).includes(q)).map((c) => ({ c, recent: false }));
    const recent = readRecent().map((id) => companies.find((c) => c.id === id)).filter(Boolean).slice(0, 3) as typeof companies;
    if (!withSearch || !recent.length) return companies.map((c) => ({ c, recent: false }));
    const rest = companies.filter((c) => !recent.some((r) => r.id === c.id));
    return [...recent.map((c) => ({ c, recent: true })), ...rest.map((c) => ({ c, recent: false }))];
  }, [companies, query, withSearch, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const idx = Math.max(0, companies.findIndex((c) => c.id === current?.id));
    setActive(withSearch ? 0 : idx);
    window.setTimeout(() => (withSearch ? inputRef.current : listRef.current)?.focus(), 0);
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(id: string) {
    const c = companies.find((x) => x.id === id);
    if (!c) return;
    setCurrent(c);
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((x) => x !== id)].slice(0, 5)));
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(options.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Home" && !withSearch) { e.preventDefault(); setActive(0); }
    else if (e.key === "End" && !withSearch) { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter") { e.preventDefault(); const o = options[active]; if (o) choose(o.c.id); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); buttonRef.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  }

  if (companies.length === 0) {
    return (
      <span className="flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-mac-body text-(--text-secondary) bg-(--bg-hover) min-w-0"
        title="Nenhuma empresa foi liberada para a sua conta. Peça acesso a quem administra.">
        <Building2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">Sem empresa liberada</span>
      </span>
    );
  }

  const activeId = options[active] ? `empresa-op-${options[active].c.id}` : undefined;
  let lastGroup: string | null = null;

  return (
    <div className="relative min-w-0 shrink" ref={rootRef}>
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Empresa: ${current?.name ?? "nenhuma selecionada"}. Trocar de empresa`}
        className="flex items-center gap-1.5 h-7 pointer-coarse:h-10 px-3 rounded-[6px] text-mac-body font-medium text-(--text-primary) bg-black/3 dark:bg-white/4 hover:bg-black/6 dark:hover:bg-white/8 transition-colors duration-fast min-w-0 max-w-[clamp(100px,calc(100vw-236px),280px)] md:max-w-[320px]"
      >
        <Building2 className="w-3.5 h-3.5 shrink-0 text-(--text-secondary)" aria-hidden="true" />
        <span className="truncate">{current?.name ?? "Selecionar empresa"}</span>
        <ChevronsUpDown className="w-3.5 h-3.5 shrink-0 text-(--text-secondary)" aria-hidden="true" />
      </button>

      {open && (
        <div className="menu-in absolute top-full left-0 mt-1.5 w-[min(320px,calc(100vw-24px))] glass-dialog glass-blur-strong rounded-(--radius-popover) shadow-dropdown z-50 overflow-hidden">
          {withSearch && (
            <div className="flex items-center gap-2 px-3 border-b border-(--border-default)">
              <Search className="w-3.5 h-3.5 text-(--text-secondary) shrink-0" aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                role="combobox"
                aria-expanded="true"
                aria-controls="empresas-lista"
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label="Buscar empresa"
                placeholder={`Buscar entre ${companies.length} empresas…`}
                className="flex-1 h-10 bg-transparent text-mac-body text-(--text-primary) placeholder:text-(--text-secondary) outline-hidden"
              />
            </div>
          )}
          <ul
            ref={listRef}
            id="empresas-lista"
            role="listbox"
            aria-label="Empresas"
            tabIndex={withSearch ? -1 : 0}
            aria-activedescendant={withSearch ? undefined : activeId}
            onKeyDown={withSearch ? undefined : onKeyDown}
            className="max-h-[min(60vh,360px)] overflow-y-auto py-1 focus:outline-hidden"
          >
            {options.length === 0 && (
              <li role="presentation" className="px-3 py-4 text-center text-mac-caption text-(--text-secondary)">Nenhuma empresa com esse nome.</li>
            )}
            {options.map(({ c, recent }, idx) => {
              const group = withSearch && !query.trim() && options.some((o) => o.recent) ? (recent ? "Usadas por último" : "Todas") : null;
              const header = group && group !== lastGroup ? group : null;
              lastGroup = group;
              const selected = current?.id === c.id;
              return (
                <li key={c.id} role="presentation">
                  {header && <p aria-hidden="true" className="px-3 pt-2 pb-1 text-mac-caption font-semibold uppercase tracking-[0.06em] text-(--text-secondary)">{header}</p>}
                  <div
                    id={`empresa-op-${c.id}`}
                    role="option"
                    aria-selected={selected}
                    data-idx={idx}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => choose(c.id)}
                    className={`mx-1 flex items-center gap-2 px-2.5 min-h-8 pointer-coarse:min-h-11 rounded-[6px] cursor-default text-mac-body transition-colors duration-fast ${
                      idx === active ? "bg-teal-600 text-white" : selected ? "text-(--text-accent)" : "text-(--text-primary)"
                    }`}
                  >
                    <span className="flex-1 truncate">{c.name}</span>
                    {selected && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
