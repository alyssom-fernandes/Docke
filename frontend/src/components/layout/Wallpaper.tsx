/**
 * Papel de parede da tela de bloqueio e das páginas públicas: folhas de vidro
 * curvas, com a borda acesa, sobre o teal do Docke. É um desenho próprio, no
 * espírito dos papéis de parede do macOS 27. As cores vêm das variáveis de
 * `.wallpaper-screen` (versão de dia e de noite, conforme o tema).
 */
export default function Wallpaper({ fixed = false, className = "" }: { fixed?: boolean; className?: string }) {
  const stop = (color: string, opacity: number | string) => ({ stopColor: `var(${color})`, stopOpacity: opacity });
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className={`pointer-events-none ${fixed ? "fixed" : "absolute"} inset-0 h-full w-full ${className}`}
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="dk-wp-base" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" style={stop("--wp-top", 1)} />
          <stop offset="0.55" style={stop("--wp-mid", 1)} />
          <stop offset="1" style={stop("--wp-bottom", 1)} />
        </linearGradient>
        <radialGradient id="dk-wp-glow-a" cx="0.8" cy="0.06" r="0.62">
          <stop offset="0" style={stop("--wp-glow-a", 0.85)} />
          <stop offset="1" style={stop("--wp-glow-a", 0)} />
        </radialGradient>
        <radialGradient id="dk-wp-glow-b" cx="0.06" cy="0.5" r="0.55">
          <stop offset="0" style={stop("--wp-glow-b", 0.75)} />
          <stop offset="1" style={stop("--wp-glow-b", 0)} />
        </radialGradient>
        <radialGradient id="dk-wp-vignette" cx="0.5" cy="1.08" r="0.72">
          <stop offset="0" stopColor="#000" stopOpacity="0.42" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dk-wp-sheet-l" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop("--wp-sheet", "var(--wp-sheet-op)")} />
          <stop offset="1" style={stop("--wp-sheet", 0)} />
        </linearGradient>
        <linearGradient id="dk-wp-sheet-r" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={stop("--wp-sheet", "var(--wp-sheet-op)")} />
          <stop offset="1" style={stop("--wp-sheet", 0.02)} />
        </linearGradient>
        <linearGradient id="dk-wp-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={stop("--wp-rim", 0.95)} />
          <stop offset="0.55" style={stop("--wp-rim", 0.4)} />
          <stop offset="1" style={stop("--wp-rim", 0)} />
        </linearGradient>
        <filter id="dk-wp-soft" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="12" />
        </filter>
      </defs>

      <rect width="1600" height="1000" fill="url(#dk-wp-base)" />
      <rect width="1600" height="1000" fill="url(#dk-wp-glow-a)" />
      <rect width="1600" height="1000" fill="url(#dk-wp-glow-b)" />

      {/* Folha da esquerda, em duas camadas */}
      <path d="M -20 -20 L 720 -20 C 640 250 400 570 -20 870 Z" fill="url(#dk-wp-sheet-l)" />
      <path d="M 720 -20 C 640 250 400 570 -20 870" fill="none" stroke="url(#dk-wp-rim)" strokeWidth="16" opacity="0.4" filter="url(#dk-wp-soft)" />
      <path d="M 720 -20 C 640 250 400 570 -20 870" fill="none" stroke="url(#dk-wp-rim)" strokeWidth="1.6" />
      <path d="M -20 -20 L 480 -20 C 420 190 260 410 -20 610 Z" fill="url(#dk-wp-sheet-l)" />
      <path d="M 480 -20 C 420 190 260 410 -20 610" fill="none" stroke="url(#dk-wp-rim)" strokeWidth="1.2" opacity="0.7" />

      {/* Folha da direita, também em duas camadas */}
      <path d="M 1090 -20 C 1330 170 1450 530 1220 1020 L 1620 1020 L 1620 -20 Z" fill="url(#dk-wp-sheet-r)" />
      <path d="M 1090 -20 C 1330 170 1450 530 1220 1020" fill="none" stroke="url(#dk-wp-rim)" strokeWidth="16" opacity="0.4" filter="url(#dk-wp-soft)" />
      <path d="M 1090 -20 C 1330 170 1450 530 1220 1020" fill="none" stroke="url(#dk-wp-rim)" strokeWidth="1.6" />
      <path d="M 1320 -20 C 1470 120 1570 300 1620 430 L 1620 -20 Z" fill="url(#dk-wp-sheet-r)" />
      <path d="M 1320 -20 C 1470 120 1570 300 1620 430" fill="none" stroke="url(#dk-wp-rim)" strokeWidth="1.2" opacity="0.7" />

      {/* Onda de baixo, mais escura, para o texto dos campos ler bem */}
      <path d="M -20 1020 L -20 900 C 380 770 900 1010 1620 720 L 1620 1020 Z" fill="#000" opacity="0.18" />
      <path d="M -20 900 C 380 770 900 1010 1620 720" fill="none" stroke="url(#dk-wp-rim)" strokeWidth="1.2" opacity="0.35" />
      <rect width="1600" height="1000" fill="url(#dk-wp-vignette)" />
    </svg>
  );
}
