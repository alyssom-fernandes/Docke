import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
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
        fast: "120ms",
        normal: "180ms",
        slow: "240ms",
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

export default config;
