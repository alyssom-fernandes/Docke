import { KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Folder, Home, Search } from "lucide-react";
import api from "@/lib/api";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";

interface FlatFolder {
  id: string;
  name: string;
  parent_id: string | null;
  path: string;
}

export interface PickedFolder {
  id: string | null;
  name: string;
}

interface Props {
  companyId: string;
  title: string;
  description?: string;
  confirmLabel: string;
  /** Pastas que não podem ser escolhidas (a própria pasta movida, a pasta atual). */
  disabledIds?: string[];
  /** Mover pasta: a pasta e todas as suas subpastas ficam de fora. */
  excludeSubtreeOf?: string[];
  /** Pastas podem ir para a raiz (Início); documentos não. */
  allowRoot?: boolean;
  initialId?: string | null;
  onPick: (folder: PickedFolder) => void | Promise<void>;
  onClose: () => void;
}

/**
 * Escolher uma pasta de destino ("Mover para…", destino do envio). Árvore
 * inteira em lista recuada, com busca por nome; setas e Enter escolhem, e as
 * pastas que não podem receber o item aparecem desabilitadas com o motivo.
 * Resolve o "mover só arrastando" (achados A4-36 e X1-08): funciona no
 * teclado e no toque.
 */
export default function FolderPickerDialog({
  companyId, title, description, confirmLabel, disabledIds = [], excludeSubtreeOf = [], allowRoot = false,
  initialId = null, onPick, onClose,
}: Props) {
  const [folders, setFolders] = useState<FlatFolder[] | null>(null);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  function load() {
    setError(false);
    api.get<FlatFolder[]>("/folders", { params: { company_id: companyId, flat: true } })
      .then((r) => setFolders(Array.isArray(r.data) ? r.data : []))
      .catch(() => setError(true));
  }
  useEffect(load, [companyId]);

  const rows = useMemo(() => {
    if (!folders) return [];
    const byParent = new Map<string | null, FlatFolder[]>();
    for (const f of folders) {
      const list = byParent.get(f.parent_id) ?? [];
      list.push(f);
      byParent.set(f.parent_id, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base" }));
    const excludedPaths = folders.filter((f) => excludeSubtreeOf.includes(f.id)).map((f) => f.path);
    const out: { f: FlatFolder; depth: number; trail: string; disabled: string | null }[] = [];
    const walk = (parent: string | null, depth: number, trail: string) => {
      for (const f of byParent.get(parent) ?? []) {
        const inSubtree = excludedPaths.some((p) => f.path === p || f.path.startsWith(p + "."));
        const disabled = inSubtree ? "não pode ir para dentro de si mesma" : disabledIds.includes(f.id) ? "já está aqui" : null;
        const t = trail ? `${trail} › ${f.name}` : f.name;
        out.push({ f, depth, trail: t, disabled });
        walk(f.id, depth + 1, t);
      }
    };
    walk(null, 0, "");
    const q = query.trim().toLowerCase();
    return q ? out.filter((r) => r.trail.toLowerCase().includes(q)) : out;
  }, [folders, query, disabledIds, excludeSubtreeOf]);

  const options: (string | null)[] = [
    ...(allowRoot && !query.trim() ? [null] : []),
    ...rows.filter((r) => !r.disabled).map((r) => r.f.id),
  ];

  useEffect(() => {
    if (selected === undefined && folders) {
      const start = initialId && options.includes(initialId) ? initialId : options[0];
      if (start !== undefined) setSelected(start);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-id="${selected ?? "raiz"}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function onListKey(e: KeyboardEvent) {
    const i = options.indexOf(selected ?? null);
    if (e.key === "ArrowDown") { e.preventDefault(); setSelected(options[Math.min(options.length - 1, i + 1)]); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected(options[Math.max(0, i - 1)]); }
    else if (e.key === "Home") { e.preventDefault(); setSelected(options[0]); }
    else if (e.key === "End") { e.preventDefault(); setSelected(options[options.length - 1]); }
    else if (e.key === "Enter") { e.preventDefault(); confirm(); }
  }

  async function confirm() {
    if (selected === undefined) return;
    const name = selected === null ? "Início" : folders?.find((f) => f.id === selected)?.name ?? "";
    setBusy(true);
    try {
      await onPick({ id: selected, name });
    } finally {
      setBusy(false);
    }
  }

  const optionClass = (active: boolean, disabled: boolean) =>
    `flex items-center gap-2 h-8 pointer-coarse:h-11 pr-3 rounded-[6px] text-mac-body select-none ${
      disabled ? "text-(--text-tertiary) cursor-not-allowed" : active ? "bg-teal-600 text-white" : "text-(--text-primary) hover:bg-(--bg-hover) cursor-pointer"
    }`;

  return (
    <Dialog
      onClose={onClose}
      title={title}
      description={description}
      size="md"
      busy={busy}
      bodyClassName="py-3"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={confirm} loading={busy} disabled={selected === undefined}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="relative mb-2">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-tertiary)" aria-hidden />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(undefined); }}
          onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setSelected(options[0]); listRef.current?.focus(); } }}
          placeholder="Procurar pasta"
          aria-label="Procurar pasta"
          className="w-full h-9 pointer-coarse:h-11 pl-8 pr-3 rounded-full border border-(--border-control) bg-(--bg-card) text-mac-body text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
        />
      </div>
      {error ? (
        <div role="alert" className="py-6 text-center text-mac-body text-(--text-secondary)">
          Não foi possível carregar as pastas.{" "}
          <button onClick={load} className="font-medium text-(--text-accent) underline underline-offset-2">Tentar de novo</button>
        </div>
      ) : folders === null ? (
        <div className="space-y-1.5" aria-label="Carregando pastas">
          {[70, 55, 80, 45, 60].map((w, i) => (
            <div key={i} className="h-7 rounded-[6px] bg-(--bg-hover) animate-pulse" style={{ width: `${w}%`, marginLeft: (i % 3) * 16 }} />
          ))}
        </div>
      ) : (
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Pastas de destino"
          aria-activedescendant={selected === undefined ? undefined : `pasta-opcao-${selected ?? "raiz"}`}
          tabIndex={0}
          onKeyDown={onListKey}
          className="max-h-[min(52vh,420px)] overflow-y-auto rounded-(--radius-control) border border-(--border-default) p-1 focus:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
        >
          {allowRoot && !query.trim() && (
            <li
              id="pasta-opcao-raiz"
              data-id="raiz"
              role="option"
              aria-selected={selected === null}
              onClick={() => setSelected(null)}
              onDoubleClick={confirm}
              className={`${optionClass(selected === null, false)} pl-2`}
            >
              <Home className="w-4 h-4 shrink-0" aria-hidden />
              Início (raiz da empresa)
            </li>
          )}
          {rows.length === 0 && (
            <li className="py-6 text-center text-mac-body text-(--text-secondary)">Nenhuma pasta com "{query.trim()}".</li>
          )}
          {rows.map(({ f, depth, trail, disabled }) => (
            <li
              key={f.id}
              id={`pasta-opcao-${f.id}`}
              data-id={f.id}
              role="option"
              aria-selected={selected === f.id}
              aria-disabled={!!disabled || undefined}
              title={disabled ? `${f.name}: ${disabled}` : trail}
              onClick={() => { if (!disabled) setSelected(f.id); }}
              onDoubleClick={() => { if (!disabled) confirm(); }}
              className={optionClass(selected === f.id, !!disabled)}
              style={{ paddingLeft: query.trim() ? 8 : 8 + depth * 18 }}
            >
              <Folder className={`w-4 h-4 shrink-0 ${selected === f.id ? "text-white fill-white/25" : "text-(--text-accent) fill-teal-500/20"}`} aria-hidden />
              <span className="truncate">{query.trim() ? trail : f.name}</span>
              {disabled && <span className="ml-auto shrink-0 text-mac-caption">{disabled}</span>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
