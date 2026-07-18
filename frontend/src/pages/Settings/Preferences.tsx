import { useState } from "react";
import { Sliders, Sun, Moon, Monitor, Rows3, Rows4 } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { getThemePreference, setThemePreference } from "@/lib/theme";

const THEME_OPTIONS = [
  { value: "light" as const, label: "Claro", icon: Sun },
  { value: "dark" as const, label: "Escuro", icon: Moon },
  { value: "system" as const, label: "Sistema", icon: Monitor },
];

type Density = "comfortable" | "compact";

const DENSITY_OPTIONS = [
  { value: "comfortable" as const, label: "Confortável", icon: Rows3 },
  { value: "compact" as const, label: "Compacto", icon: Rows4 },
];

export default function Preferences() {
  usePageTitle("Preferências");
  const [theme, setTheme] = useState(getThemePreference());
  const [density, setDensity] = useState<Density>(
    () => (localStorage.getItem("docke_table_density") as Density) || "comfortable"
  );

  function choose(value: "light" | "dark" | "system") {
    setThemePreference(value);
    setTheme(value);
  }

  function chooseDensity(value: Density) {
    localStorage.setItem("docke_table_density", value);
    setDensity(value);
  }

  return (
    <div>
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Sliders className="w-4 h-4 text-teal-500" />
            <h3 className="text-mac-body font-medium text-[var(--text-primary)]">Tema</h3>
          </div>
          {/* Miniaturas visuais + radio embaixo — igual ao seletor de
              Appearance do System Settings real, em vez de só ícone+label. */}
          <div className="grid grid-cols-3 gap-3 max-w-[420px]">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => choose(opt.value)}
                className="flex flex-col items-center gap-2 group"
              >
                <span
                  className={`w-full aspect-[4/3] rounded-[10px] border-2 overflow-hidden flex items-center justify-center transition-colors duration-fast ${
                    theme === opt.value ? "border-teal-500" : "border-transparent group-hover:border-[var(--border-default)]"
                  }`}
                  style={{
                    background:
                      opt.value === "light" ? "#E9E9E3" :
                      opt.value === "dark" ? "#1E1E1E" :
                      "linear-gradient(135deg, #E9E9E3 50%, #1E1E1E 50%)",
                  }}
                >
                  <opt.icon className={`w-5 h-5 ${opt.value === "light" ? "text-amber-500" : opt.value === "dark" ? "text-slate-300" : "text-teal-400"}`} />
                </span>
                <span className="flex items-center gap-1.5 text-mac-caption text-[var(--text-secondary)]">
                  <span className={`w-3 h-3 rounded-full border flex items-center justify-center flex-shrink-0 ${theme === opt.value ? "border-teal-500" : "border-[var(--border-default)]"}`}>
                    {theme === opt.value && <span className="w-1.5 h-1.5 rounded-full bg-teal-500" />}
                  </span>
                  {opt.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="pt-6 border-t border-[var(--border-default)]">
          <div className="flex items-center gap-2 mb-3">
            <Rows3 className="w-4 h-4 text-teal-500" />
            <h3 className="text-mac-body font-medium text-[var(--text-primary)]">Densidade da tabela</h3>
          </div>
          <div className="grid grid-cols-2 gap-2 max-w-[280px]">
            {DENSITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => chooseDensity(opt.value)}
                className={`flex flex-col items-center gap-1.5 py-3 rounded-[var(--radius-control)] border text-mac-body transition-colors duration-fast ${
                  density === opt.value
                    ? "border-teal-500 bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400"
                    : "border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <opt.icon className="w-4 h-4" />
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-mac-caption text-[var(--text-tertiary)] mt-2">
            Aplica-se à listagem de documentos.
          </p>
        </div>
      </div>
    </div>
  );
}
