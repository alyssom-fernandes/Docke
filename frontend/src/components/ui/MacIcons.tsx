import { useId } from "react";

/**
 * Ícones de arquivo no estilo do Finder (macOS 27), desenhados para o Docke:
 * a pasta é preenchida, com a aba atrás e a frente mais clara, nos tons do
 * teal da marca; o documento é uma folha branca com o canto dobrado e uma
 * faixa na cor do tipo (PDF vermelho, planilha verde, texto azul…). Mesmos
 * ícones nos dois temas, como no macOS.
 */

export function MacFolderIcon({ className = "w-4 h-4", open = false }: { className?: string; open?: boolean }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 52" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-fundo`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3DB4A2" />
          <stop offset="1" stopColor="#2A9888" />
        </linearGradient>
        <linearGradient id={`${id}-frente`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7FDCCD" />
          <stop offset="1" stopColor="#4FC3B1" />
        </linearGradient>
      </defs>
      <path d="M3 9.6A4.6 4.6 0 0 1 7.6 5h13.9c1.4 0 2.7.6 3.5 1.7l2.3 2.8h29.1A4.6 4.6 0 0 1 61 14.1v31.3a4.6 4.6 0 0 1-4.6 4.6H7.6A4.6 4.6 0 0 1 3 45.4z" fill={`url(#${id}-fundo)`} />
      {open ? (
        <path d="M5.4 20.6A4.6 4.6 0 0 1 9.9 17h48.6a3 3 0 0 1 2.9 3.6l-4.6 25.7a4.6 4.6 0 0 1-4.5 3.7H7.6A4.6 4.6 0 0 1 3 45.4l2.4-24.8z" fill={`url(#${id}-frente)`} />
      ) : (
        <path d="M3 18.1a4.6 4.6 0 0 1 4.6-4.6h48.8a4.6 4.6 0 0 1 4.6 4.6v27.3a4.6 4.6 0 0 1-4.6 4.6H7.6A4.6 4.6 0 0 1 3 45.4z" fill={`url(#${id}-frente)`} />
      )}
      <path d="M7.6 14h48.8a4.1 4.1 0 0 1 4.1 4.1" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1" />
    </svg>
  );
}

/** Folha com o canto dobrado e a faixa do tipo; `label` aparece na faixa (PDF, XLS…). */
export function MacDocumentIcon({ className = "w-4 h-4", color, label }: { className?: string; color: string; label?: string }) {
  return (
    <svg viewBox="0 0 40 40" className={className} aria-hidden="true" focusable="false">
      <path d="M9.4 2.5h15.2l8.2 8.2v25.1a1.7 1.7 0 0 1-1.7 1.7H9.4a1.7 1.7 0 0 1-1.7-1.7V4.2a1.7 1.7 0 0 1 1.7-1.7z" fill="#FFFFFF" stroke="rgba(0,0,0,0.22)" strokeWidth="1" />
      <path d="M24.6 2.5v6.5a1.7 1.7 0 0 0 1.7 1.7h6.5" fill="#EDEDED" stroke="rgba(0,0,0,0.22)" strokeWidth="1" strokeLinejoin="round" />
      <rect x="7.7" y="25.5" width="25.1" height="8.5" fill={color} />
      {label && (
        <text x="20.25" y="31.8" textAnchor="middle" fontSize="6.4" fontWeight="700" fill="#FFFFFF" fontFamily="-apple-system, BlinkMacSystemFont, Inter, sans-serif" letterSpacing="0.3">
          {label}
        </text>
      )}
    </svg>
  );
}
