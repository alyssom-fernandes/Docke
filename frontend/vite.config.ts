import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

// __dirname = frontend/ regardless of Node.js cwd
const root = __dirname.replace(/\\/g, "/");

// ⚠️ ARMADILHA DE CONFIG DUPLICADA — leia antes de editar tema/tokens.
// Este arquivo define um bloco `theme.extend` do Tailwind INLINE, passado
// direto pro plugin do PostCSS abaixo. Como o Vite recebe `css.postcss.plugins`
// explicitamente aqui, ele NUNCA lê `postcss.config.js`/`tailwind.config.cjs`
// pro build/dev real — essa cópia É a fonte de verdade que o navegador
// realmente usa. `tailwind.config.cjs` continua existindo só pra IntelliSense
// do editor e pro `npx tailwindcss` standalone; editar só ele NÃO MUDA NADA
// no app rodando (foi exatamente isso que causou o mistério da "escala x1.2"
// nas durações de transição em 22/07/2026 — o comentário sobre fontFamily.sans
// em styles/tokens.css:10-13 é a mesma armadilha, sofrida numa sessão anterior).
// Ao mudar qualquer valor de tema, edite os DOIS arquivos juntos.
export default defineConfig({
  plugins: [react()],
  css: {
    postcss: {
      plugins: [
        tailwindcss({
          darkMode: "class",
          content: [
            `${root}/index.html`,
            `${root}/src/**/*.{ts,tsx}`,
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
                // Ease-out de verdade (Tailwind's próprio valor nomeado
                // "ease-out"), substituindo o DEFAULT (cubic-bezier(0.4,0,0.2,1),
                // curva "standard" do Material — nem ease-out nem ease-in-out).
                // Ver nota grande no topo deste arquivo sobre por que esta cópia
                // é a que realmente vale.
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
        }),
        autoprefixer(),
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
