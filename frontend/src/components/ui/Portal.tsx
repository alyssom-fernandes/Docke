import { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * backdrop-filter (e transform/filter/perspective) cria um novo containing
 * block pra descendentes position:fixed — se um modal for renderizado dentro
 * da árvore de uma página com painel .glass-blur-card, seu scrim "fixed
 * inset-0" fica preso aos limites desse painel em vez de cobrir a viewport
 * inteira. Portal escapa pra document.body e resolve isso na raiz.
 */
export default function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
