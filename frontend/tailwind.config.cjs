/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
  ],
  safelist: [
    "text-mac-caption2", "text-mac-caption", "text-mac-footnote", "text-mac-body",
    "text-mac-callout", "text-mac-title3", "text-mac-title2", "text-mac-title1", "text-mac-large",
    "text-sm", "text-xs", "text-lg", "text-xl", "text-2xl",
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
        sans: ["-apple-system", "BlinkMacSystemFont", "Inter", "Segoe UI", "sans-serif"],
        mono: ["JetBrains Mono", "Consolas", "monospace"],
      },
      fontSize: {
        "mac-caption2": ["10px", "12px"],
        "mac-caption": ["11px", "14px"],
        "mac-footnote": ["12px", "15px"],
        "mac-body": ["13px", "16px"],
        "mac-callout": ["14px", "18px"],
        "mac-title3": ["15px", "19px"],
        "mac-title2": ["17px", "22px"],
        "mac-title1": ["22px", "28px"],
        "mac-large": ["26px", "32px"],
      },
      borderRadius: {
        badge: "4px",
        mac: "6px",
        sm: "8px",
        card: "12px",
        dialog: "14px",
        stat: "16px",
      },
      transitionDuration: {
        fast: "100ms",
        normal: "150ms",
        slow: "220ms",
      },
      transitionTimingFunction: {
        // Sobrescreve o DEFAULT do Tailwind (cubic-bezier(0.4,0,0.2,1), a curva
        // "standard" do Material Design) por um ease-out de verdade. Sem isso,
        // toda classe transition-* sem ease-* explícito herdava uma curva que
        // não é nem ease-out nem ease-in-out — apenas parecida com as duas.
        // Aplica-se globalmente (nenhum componente sobrescreve com uma curva
        // própria hoje), então corrige os 130+ usos de duration-fast/normal/slow
        // de uma vez, sem tocar em cada arquivo.
        DEFAULT: "cubic-bezier(0, 0, 0.2, 1)",
      },
      boxShadow: {
        card: "0 4px 12px rgba(0,0,0,0.06)",
        dropdown: "var(--shadow-dropdown)",
        modal: "var(--shadow-dialog)",
        drag: "0 12px 36px rgba(0,0,0,0.16)",
      },
    },
  },
  plugins: [],
};
