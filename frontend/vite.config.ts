import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // Tailwind 4: tema em src/styles/tokens.css (@theme); prefixos de navegador
  // ficam por conta do próprio Tailwind (Lightning CSS), sem autoprefixer.
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
