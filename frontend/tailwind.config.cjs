const path = require("path");

/** @type {import('tailwindcss').Config} */
// Fonte única do tema do Tailwind. Antes havia uma segunda cópia inline em
// vite.config.ts — era ela que valia no build, e esta aqui só servia ao editor
// (as duas divergiam: raios, sombras, safelist). Esta é a cópia que valia.
// As classes text-mac-* não são do Tailwind: ficam em src/styles/tokens.css.
module.exports = {
  darkMode: "class",
  // Caminhos absolutos: o dev server às vezes roda a partir da raiz do
  // repositório (.claude/launch.json), e "./src" apontaria para o lugar errado.
  content: [
    path.join(__dirname, "index.html").replace(/\\/g, "/"),
    path.join(__dirname, "src/**/*.{ts,tsx}").replace(/\\/g, "/"),
  ],
  theme: {
    extend: {
      colors: {
        teal: {
          50: "#E6F5F2",
          100: "#B3E5D8",
          200: "#7DD4C0",
          400: "#3FBFA8",
          500: "#15A18E",
          600: "#0B8578",
          700: "#086B61",
          800: "#054F48",
          900: "#033530",
        },
        bg: {
          page: "var(--bg-page)",
          card: "var(--bg-card)",
          elevated: "var(--bg-elevated)",
          hover: "var(--bg-hover)",
        },
        border: {
          default: "var(--border-default)",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          tertiary: "var(--text-tertiary)",
          placeholder: "var(--text-placeholder)",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
      borderRadius: {
        badge: "4px",
        sm: "8px",
        card: "12px",
        stat: "16px",
      },
      transitionDuration: {
        fast: "100ms",
        normal: "150ms",
        slow: "220ms",
      },
      transitionTimingFunction: {
        // Ease-out de verdade, no lugar do DEFAULT do Tailwind
        // (cubic-bezier(0.4,0,0.2,1), a curva "standard" do Material).
        DEFAULT: "cubic-bezier(0, 0, 0.2, 1)",
      },
      boxShadow: {
        card: "0 4px 12px rgba(0,0,0,0.06)",
        dropdown: "0 4px 16px rgba(0,0,0,0.10)",
        modal: "0 8px 24px rgba(0,0,0,0.12)",
        drag: "0 12px 36px rgba(0,0,0,0.16)",
      },
    },
  },
  plugins: [],
};
