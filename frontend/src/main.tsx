import { installErrorReporting } from "@/lib/reportError";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Fontes servidas pelo próprio site (antes vinham do Google Fonts, que
// recebia o IP de cada visitante). Mesmos pesos que o link antigo carregava.
// Só o subconjunto latino (cobre o português): o build levava 74 arquivos de
// fonte de alfabetos que o app não usa (X1-23).
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
// 700: os títulos (Title1/Title2/Large) pedem negrito; sem este arquivo o
// navegador engrossava o 600 por conta própria (negrito falso).
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-700.css";
import "./styles/tokens.css";
import { applyTheme, getTheme, getThemePreference } from "@/lib/theme";
applyTheme(getTheme(), getThemePreference() !== "system");
// "Seguir o sistema": acompanha a troca do sistema sem recarregar.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
  if (getThemePreference() === "system") applyTheme(e.matches ? "dark" : "light", false);
});
import { AuthProvider } from "@/lib/AuthContext";
import { ToastProvider } from "@/lib/toast";
import { CommandPaletteProvider } from "@/hooks/useCommandPalette";
import { TaskProvider } from "@/lib/TaskContext";
import { NavigationProvider } from "@/lib/NavigationContext";

// Service worker só para receber o "Compartilhar" do celular (B4.5.7); não
// guarda o app em cache. Fora de produção não registra (o Vite serve a raiz).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}

installErrorReporting();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <ToastProvider>
        <TaskProvider>
          <NavigationProvider>
            <CommandPaletteProvider>
              <App />
            </CommandPaletteProvider>
          </NavigationProvider>
        </TaskProvider>
      </ToastProvider>
    </AuthProvider>
  </React.StrictMode>
);
