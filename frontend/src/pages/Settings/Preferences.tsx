import { useState } from "react";
import { Sliders, Sun, Moon, Monitor, Rows3 } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { getThemePreference, setThemePreference } from "@/lib/theme";

const THEME_OPTIONS = [
  { value: "light" as const, label: "Claro", icon: Sun },
  { value: "dark" as const, label: "Escuro", icon: Moon },
  { value: "system" as const, label: "Sistema", icon: Monitor },
];

export default function Preferences() {
  usePageTitle("Preferências");
  const [theme, setTheme] = useState(getThemePreference());

  function choose(value: "light" | "dark" | "system") {
    setThemePreference(value);
    setTheme(value);
  }

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-[var(--text-primary)]">Preferências</h2>

      <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] p-6 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Sliders className="w-4 h-4 text-teal-600" />
            <h3 className="text-sm font-medium text-[var(--text-primary)]">Tema</h3>
          </div>
          <div className="grid grid-cols-3 gap-2 max-w-[400px]">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => choose(opt.value)}
                className={`flex flex-col items-center gap-1.5 py-3 rounded-[8px] border text-sm transition-colors duration-fast ${
                  theme === opt.value
                    ? "border-teal-600 bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400"
                    : "border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <opt.icon className="w-4 h-4" />
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-6 border-t border-[var(--border-default)]">
          <div className="flex items-center gap-2 mb-1">
            <Rows3 className="w-4 h-4 text-[var(--text-tertiary)]" />
            <h3 className="text-sm font-medium text-[var(--text-tertiary)]">Densidade da tabela</h3>
          </div>
          <p className="text-xs text-[var(--text-tertiary)]">
            Alternância entre compacto e confortável chega em uma próxima versão.
          </p>
        </div>
      </div>
    </div>
  );
}
