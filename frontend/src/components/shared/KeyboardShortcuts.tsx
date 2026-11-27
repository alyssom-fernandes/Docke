import { useEffect, useState } from "react";
import Dialog from "@/components/ui/Dialog";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

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

  if (!open) return null;
  return (
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
  );
}
