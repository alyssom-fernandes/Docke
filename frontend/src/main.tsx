import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Fontes servidas pelo próprio site (antes vinham do Google Fonts, que
// recebia o IP de cada visitante). Mesmos pesos que o link antigo carregava.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles/tokens.css";
import { applyTheme, getTheme } from "@/lib/theme";
applyTheme(getTheme());
import { AuthProvider } from "@/lib/AuthContext";
import { ToastProvider } from "@/lib/toast";
import { CommandPaletteProvider } from "@/hooks/useCommandPalette";
import { TaskProvider } from "@/lib/TaskContext";
import { NavigationProvider } from "@/lib/NavigationContext";

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
