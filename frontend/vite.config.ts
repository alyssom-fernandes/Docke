import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Tailwind e autoprefixer vêm do postcss.config.js, que lê o
  // tailwind.config.cjs — fonte única do tema.
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
