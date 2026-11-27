import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import Dialog from "@/components/ui/Dialog";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

/** "G" e depois a letra leva à tela (B4.6.7), como no Linear e no GitHub. */
const IR_PARA: [string, string, string][] = [
  ["i", "/dashboard", "Início"],
  ["d", "/documents", "Documentos"],
  ["b", "/search", "Busca"],
  ["o", "/obligations", "Obrigações"],
  ["a", "/activity", "Atividade"],
  ["l", "/shares", "Links"],
  ["n", "/favorites", "Ancorados"],
  ["t", "/trash", "Lixeira"],
  ["j", "/settings", "Ajustes"],
];

const GRUPOS: { titulo: string; itens: [string, string][] }[] = [
  {
    titulo: "Em qualquer tela",
    itens: [
      [`${MOD} K`, "Buscar documentos, pastas e ações"],
      ["Alt Shift D", "Alternar tema claro e escuro"],
      ["?", "Mostrar estes atalhos"],
      ["Esc", "Fechar janela, menu ou busca"],
    ],
  },
  {
    titulo: "Ir para (G e depois a letra; fora de Documentos)",
    itens: IR_PARA.map(([k, , nome]) => [`G ${k.toUpperCase()}`, nome] as [string, string]),
  },
  {
    titulo: "Em Documentos",
    itens: [
      ["Espaço", "Abrir a prévia do item em foco"],
      ["Enter", "Abrir a pasta em foco"],
      ["F2", "Renomear"],
      ["Del", "Mover para a lixeira"],
      [`${MOD} Shift N`, "Nova pasta"],
      [`${MOD} A`, "Selecionar todos os documentos"],
      [`${MOD} Z`, "Desfazer a última ação"],
      ["↑ ↓  Home  End", "Andar pela lista"],
      ["Shift ↑ ↓", "Selecionar um intervalo"],
      ["Shift F10", "Abrir o menu do item"],
      ["Letras", "Ir ao item que começa com elas"],
    ],
  },
  {
    titulo: "Na prévia do PDF",
    itens: [
      ["Page Up / Page Down", "Página anterior / seguinte"],
      ["Home / End", "Primeira / última página"],
      [`${MOD} F`, "Buscar no texto do documento"],
      [`${MOD} + / ${MOD} −`, "Aumentar / diminuir o zoom"],
      [`${MOD} 0`, "Zoom de 100%"],
    ],
  },
];

export function openKeyboardShortcuts() {
  window.dispatchEvent(new CustomEvent("docke:atalhos"));
}

/**
 * Painel de atalhos (A2-23): abre com "?" fora de campos de texto ou pelo
 * ⌘K. Lista só atalhos que existem de fato no código.
 */
export default function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  // Depois do G, a dica com as letras fica à vista por 1,5 s (retorno visual da tecla).
  const [esperando, setEsperando] = useState(false);
  const gAt = useRef(0);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]')) return;
      // Nas listas, na árvore e em Documentos as letras pulam para o item
      // (como no Finder): lá o G não navega.
      if (window.location.pathname.startsWith("/documents")) return;
      if (t?.closest?.('[role="grid"], [role="listbox"], [role="tree"], [role="treegrid"], table, [data-typeahead]')) return;
      const k = e.key.toLowerCase();
      if (Date.now() - gAt.current < 1500) {
        gAt.current = 0;
        setEsperando(false);
        const alvo = IR_PARA.find(([letra]) => letra === k);
        if (alvo) { e.preventDefault(); navigate(alvo[1]); }
        return;
      }
      if (k === "g" && !e.shiftKey) {
        gAt.current = Date.now();
        setEsperando(true);
        window.setTimeout(() => { if (Date.now() - gAt.current >= 1500) setEsperando(false); }, 1550);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  useEffect(() => {
    function onOpen() { setOpen(true); }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      setOpen(true);
    }
    window.addEventListener("docke:atalhos", onOpen);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("docke:atalhos", onOpen); window.removeEventListener("keydown", onKey); };
  }, []);

  const dica = esperando ? createPortal(
    <div role="status" aria-live="polite" className="menu-in fixed z-[95] bottom-6 left-1/2 -translate-x-1/2 rounded-full mac-sheet px-4 py-2 text-mac-caption text-(--text-primary) shadow-(--shadow-dropdown)">
      <kbd className="font-semibold">G</kbd> e depois:{" "}
      {IR_PARA.map(([k, , nome]) => <span key={k} className="ml-2 whitespace-nowrap"><kbd className="font-semibold">{k.toUpperCase()}</kbd> {nome}</span>)}
    </div>,
    document.body,
  ) : null;

  if (!open) return dica;
  return (
    <>
    {dica}
    <Dialog onClose={() => setOpen(false)} title="Atalhos do teclado" size="md">
      <div className="space-y-5">
        {GRUPOS.map((g) => (
          <section key={g.titulo} aria-labelledby={`atalhos-${g.titulo}`}>
            <h3 id={`atalhos-${g.titulo}`} className="text-[11px] font-bold text-(--text-secondary) mb-2">{g.titulo}</h3>
            <dl className="divide-y divide-(--border-default)">
              {g.itens.map(([tecla, acao]) => (
                <div key={tecla} className="flex items-center justify-between gap-4 py-2">
                  <dt className="text-mac-body text-(--text-primary)">{acao}</dt>
                  <dd><kbd className="whitespace-nowrap rounded border border-(--border-control) bg-(--bg-hover) px-1.5 py-0.5 font-sans text-mac-caption text-(--text-primary)">{tecla}</kbd></dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
    </>
  );
}
