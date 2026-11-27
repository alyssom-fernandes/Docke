import {
  createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useState,
  type ButtonHTMLAttributes, type CSSProperties, type InputHTMLAttributes, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";

/**
 * Janela no estilo do macOS 27 (kit oficial, docs/avaliacao-2026-11/ESPEC-MACOS-27.md).
 *
 * A casca (AppShell) desenha a barra lateral e a barra de ferramentas; cada
 * página diz o próprio título, subtítulo, ações e busca com <PageHeader>, que
 * no computador vai para a barra de ferramentas da janela (como o Finder) e no
 * celular vira o título grande do iOS no topo do conteúdo.
 */

type SlotName = "toolbar" | "search";

interface WindowContextValue {
  desktop: boolean;
  slots: Record<SlotName, HTMLElement | null>;
  setSlot: (name: SlotName, el: HTMLElement | null) => void;
  /** Quantas páginas abertas trazem cabeçalho e busca próprios. */
  headers: number;
  customSearch: number;
  registerHeader: (withSearch: boolean) => () => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
}

const WindowContext = createContext<WindowContextValue | null>(null);

const DESKTOP_QUERY = "(min-width: 768px)";
const SIDEBAR_KEY = "docke_barra_lateral";

export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

export function WindowProvider({ children }: { children: ReactNode }) {
  const desktop = useIsDesktop();
  const [slots, setSlots] = useState<Record<SlotName, HTMLElement | null>>({ toolbar: null, search: null });
  const [headers, setHeaders] = useState(0);
  const [customSearch, setCustomSearch] = useState(0);
  // Barra lateral: aberta por padrão a partir de 1024 px; no tablet começa fechada.
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved !== null) return saved === "1" && window.matchMedia("(min-width: 1024px)").matches;
    return window.matchMedia("(min-width: 1024px)").matches;
  });
  const setSidebarOpen = useCallback((open: boolean) => {
    setSidebarOpenState(open);
    if (window.matchMedia("(min-width: 1024px)").matches) localStorage.setItem(SIDEBAR_KEY, open ? "1" : "0");
  }, []);
  const setSlot = useCallback((name: SlotName, el: HTMLElement | null) => {
    setSlots((prev) => (prev[name] === el ? prev : { ...prev, [name]: el }));
  }, []);
  const registerHeader = useCallback((withSearch: boolean) => {
    setHeaders((n) => n + 1);
    if (withSearch) setCustomSearch((n) => n + 1);
    return () => {
      setHeaders((n) => n - 1);
      if (withSearch) setCustomSearch((n) => n - 1);
    };
  }, []);
  const value = useMemo(
    () => ({ desktop, slots, setSlot, headers, customSearch, registerHeader, sidebarOpen, setSidebarOpen }),
    [desktop, slots, setSlot, headers, customSearch, registerHeader, sidebarOpen, setSidebarOpen],
  );
  return <WindowContext.Provider value={value}>{children}</WindowContext.Provider>;
}

export function useWindow(): WindowContextValue {
  const ctx = useContext(WindowContext);
  if (!ctx) throw new Error("useWindow fora da janela");
  return ctx;
}

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Antes do título (ex.: voltar e avançar). */
  leading?: ReactNode;
  /** Logo depois do título (ex.: selo de dado sensível). */
  titleAccessory?: ReactNode;
  /** Ações da página, à direita (cápsulas de vidro). */
  children?: ReactNode;
  /** Busca própria da página no lugar da busca geral (ex.: filtrar a pasta). */
  search?: ReactNode;
  /** Ações só do celular, ao lado do título grande (padrão: as mesmas). */
  mobileActions?: ReactNode;
  /** Conteúdo extra embaixo do título grande no celular. */
  mobileBelow?: ReactNode;
}

/**
 * Cabeçalho da página. No computador vai para a barra de ferramentas da
 * janela (título 13 px em negrito e subtítulo 11 px, como no Finder); no
 * celular é o título grande do iOS (34 px), com as ações ao lado.
 */
export function PageHeader({ title, subtitle, leading, titleAccessory, children, search, mobileActions, mobileBelow }: PageHeaderProps) {
  const { desktop, slots, registerHeader } = useWindow();
  const withSearch = search !== undefined;
  useEffect(() => registerHeader(withSearch), [registerHeader, withSearch]);

  if (desktop) {
    return (
      <>
        {slots.toolbar && createPortal(
          <>
            {leading}
            <div className="min-w-0 flex flex-col justify-center gap-[2px] pl-1">
              <h1 className="toolbar-title truncate">{title}</h1>
              {subtitle && <p className="toolbar-subtitle truncate">{subtitle}</p>}
            </div>
            {titleAccessory}
            <div className="flex-1 min-w-2" />
            {children}
          </>,
          slots.toolbar,
        )}
        {withSearch && slots.search && createPortal(search, slots.search)}
      </>
    );
  }

  // Como na barra de navegação do iOS: os botões ficam na linha de cima, à
  // direita, e o título grande ocupa a largura toda embaixo (sem cortar).
  const actions = mobileActions ?? children;
  return (
    <header className="mb-4 pt-1">
      {actions && (
        <div className="-mx-1 mb-1.5 flex items-center justify-end gap-2 overflow-x-auto px-1 py-0.5 [scrollbar-width:none]">{actions}</div>
      )}
      <h1 className="ios-large-title" style={{ textWrap: "balance" } as CSSProperties}>{title}</h1>
      {subtitle && <p className="mt-0.5 text-[15px] leading-5 text-(--text-secondary) truncate">{subtitle}</p>}
      {titleAccessory && <div className="mt-2">{titleAccessory}</div>}
      {search && <div className="mt-3 [&>*]:w-full! [&>*]:max-w-none!">{search}</div>}
      {mobileBelow}
    </header>
  );
}

/* ─── Controles da barra de ferramentas (Liquid Glass) ─────────────────────── */

/** Cápsula de vidro com vários botões (Button Group / Segmented Control do kit). */
export function ToolbarGroup({ children, label, className = "" }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <div role={label ? "group" : undefined} aria-label={label} className={`glass-capsule flex h-9 shrink-0 items-center gap-0.5 p-1 ${className}`}>
      {children}
    </div>
  );
}

export function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-(--capsule-divider)" />;
}

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Dentro de um ToolbarGroup (28 px) ou sozinho, como círculo de vidro (36 px). */
  inGroup?: boolean;
  /** Estado ligado (segmento escolhido). */
  selected?: boolean;
  /** Ação principal, preenchida com o acento (ex.: Enviar). */
  prominent?: boolean;
  label: string;
  children: ReactNode;
  /** Mostra o texto ao lado do ícone. */
  showLabel?: boolean;
}

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(function ToolbarButton(
  { inGroup = false, selected = false, prominent = false, label, children, showLabel = false, className = "", ...props },
  ref,
) {
  const shape = showLabel ? "px-2.5 gap-1.5" : inGroup ? "w-8" : "w-9";
  const size = inGroup ? "h-7" : "h-9";
  const look = prominent
    ? "bg-(--accent) text-white hover:bg-(--accent-hover) shadow-[0_0_0_0.5px_rgba(0,0,0,0.12),0_8px_15px_rgba(0,0,0,0.04)]"
    : inGroup
      ? selected
        ? "bg-(--control-fill-selected) text-(--text-primary)"
        : "text-(--text-primary) hover:bg-(--control-fill)"
      : "glass-capsule text-(--text-primary) hover:brightness-[0.97] dark:hover:brightness-125";
  return (
    <button
      ref={ref}
      type="button"
      aria-label={showLabel ? undefined : label}
      title={showLabel ? undefined : label}
      aria-pressed={inGroup && selected ? true : props["aria-pressed"]}
      className={`relative inline-flex shrink-0 items-center justify-center rounded-full ${size} ${shape} text-[13px] font-medium transition-[background-color,filter,transform] duration-fast active:scale-[0.96] disabled:opacity-(--opacity-disabled) disabled:pointer-events-none focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) [&_svg]:size-[15px] [&_svg]:shrink-0 ${look} ${className}`}
      {...props}
    >
      {children}
      {showLabel && <span className="whitespace-nowrap">{label}</span>}
    </button>
  );
});

/** Campo de busca em pílula de vidro (36 px), com X para limpar. */
export const ToolbarSearchField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { onClear?: () => void; widthClass?: string }>(
  function ToolbarSearchField({ onClear, widthClass = "w-[200px]", className = "", value, ...props }, ref) {
    const filled = typeof value === "string" ? value.length > 0 : false;
    return (
      <div className={`glass-capsule relative flex h-9 shrink-0 items-center gap-1.5 px-2.5 ${widthClass} ${className}`}>
        <Search className="size-[14px] shrink-0 text-(--text-secondary)" aria-hidden />
        <input
          ref={ref}
          type="search"
          value={value}
          className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-(--text-primary) placeholder:text-(--text-secondary) outline-hidden [&::-webkit-search-cancel-button]:hidden"
          {...props}
        />
        {filled && onClear && (
          <button type="button" onClick={onClear} aria-label="Limpar a busca" className="flex size-4 shrink-0 items-center justify-center rounded-full bg-(--text-tertiary) text-(--window-bg) hover:bg-(--text-secondary)">
            <X className="size-2.5" strokeWidth={3} aria-hidden />
          </button>
        )}
      </div>
    );
  },
);
