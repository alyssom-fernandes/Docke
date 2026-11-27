import { useState } from "react";
import { Palette, Sun, Moon, Monitor, Rows3, Rows4, Rows2, RotateCcw } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { getThemePreference, setThemePreference } from "@/lib/theme";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import api from "@/lib/api";
import DangerZone from "@/components/shared/DangerZone";
import Button from "@/components/ui/Button";
import Switch from "@/components/ui/Switch";
import PushPreference from "@/components/shared/PushPreference";
import { getReduceTransparency, setReduceTransparency } from "@/lib/theme";
import ConfirmModal from "@/components/ui/ConfirmModal";

// Mesma ordem e nomes da Aparência do macOS: Automático segue o sistema.
const THEME_OPTIONS = [
  { value: "system" as const, label: "Automático", icon: Monitor },
  { value: "light" as const, label: "Claro", icon: Sun },
  { value: "dark" as const, label: "Escuro", icon: Moon },
];

type Density = "compact" | "comfortable" | "spacious";

const DENSITY_OPTIONS = [
  { value: "compact" as const, label: "Compacta", icon: Rows4 },
  { value: "comfortable" as const, label: "Confortável", icon: Rows3 },
  { value: "spacious" as const, label: "Espaçosa", icon: Rows2 },
];

// Miniatura de janela (A8-31): barra, lateral e linhas de conteúdo no tema,
// no lugar do quadrado chapado com ícone.
function JanelaTema({ tema }: { tema: "light" | "dark" }) {
  const c = tema === "light"
    ? { fundo: "#ECECE6", janela: "#FFFFFF", lado: "#F3F3EF", linha: "#D9D9D3", forte: "#0d9488" }
    : { fundo: "#141414", janela: "#232323", lado: "#1B1B1B", linha: "#3A3A3A", forte: "#2dd4bf" };
  return (
    <svg viewBox="0 0 120 90" className="w-full h-full" aria-hidden="true">
      <rect width="120" height="90" fill={c.fundo} />
      <rect x="10" y="10" width="100" height="70" rx="6" fill={c.janela} />
      <rect x="10" y="10" width="30" height="70" rx="6" fill={c.lado} />
      <circle cx="17" cy="17" r="2" fill="#ff5f57" /><circle cx="23" cy="17" r="2" fill="#febc2e" /><circle cx="29" cy="17" r="2" fill="#28c840" />
      <rect x="15" y="27" width="20" height="4" rx="2" fill={c.forte} />
      <rect x="15" y="35" width="16" height="3" rx="1.5" fill={c.linha} />
      <rect x="15" y="41" width="18" height="3" rx="1.5" fill={c.linha} />
      <rect x="46" y="20" width="40" height="5" rx="2.5" fill={c.linha} />
      <rect x="46" y="31" width="56" height="3" rx="1.5" fill={c.linha} />
      <rect x="46" y="38" width="50" height="3" rx="1.5" fill={c.linha} />
      <rect x="46" y="45" width="54" height="3" rx="1.5" fill={c.linha} />
      <rect x="46" y="58" width="22" height="7" rx="3.5" fill={c.forte} />
    </svg>
  );
}

export default function Preferences() {
  usePageTitle("Preferências");
  const { user } = useAuthContext();
  const { success, error: showError } = useToast();
  const [theme, setTheme] = useState(getThemePreference());
  const [density, setDensity] = useState<Density>(
    () => (["compact", "comfortable", "spacious"].includes(localStorage.getItem("docke_table_density") ?? "") ? localStorage.getItem("docke_table_density") as Density : "comfortable")
  );
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  async function resetDemoData() {
    setResetting(true);
    try {
      await api.post("/admin/demo/reset");
      success("Dados demo restaurados. Recarregando…");
      setConfirmingReset(false);
      setTimeout(() => window.location.reload(), 1200);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível resetar os dados demo.");
      setResetting(false);
    }
  }

  // Troca de tema com transição curta (A8-31) onde o navegador permite e sem
  // movimento reduzido; senão, troca direta como antes.
  function choose(value: "light" | "dark" | "system") {
    const aplicar = () => { setThemePreference(value); setTheme(value); };
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (doc.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) doc.startViewTransition(aplicar);
    else aplicar();
  }

  function chooseDensity(value: Density) {
    localStorage.setItem("docke_table_density", value);
    setDensity(value);
  }
  const [reduceTransparency, setReduce] = useState(getReduceTransparency);
  function chooseReduceTransparency(v: boolean) {
    setReduce(v);
    setReduceTransparency(v);
  }

  return (
    <div>
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-6 space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Palette className="w-4 h-4 text-(--text-accent)" aria-hidden />
            <h3 id="pref-tema" className="text-mac-body font-medium text-(--text-primary)">Tema</h3>
          </div>
          {/* Miniaturas visuais + radio embaixo — igual ao seletor de
              Appearance do System Settings real, em vez de só ícone+label. */}
          <div role="radiogroup" aria-labelledby="pref-tema" className="grid grid-cols-3 gap-3 max-w-[420px]">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                role="radio"
                aria-checked={theme === opt.value}
                onClick={() => choose(opt.value)}
                className="flex flex-col items-center gap-2 group rounded-(--radius-card) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
              >
                <span
                  className={`relative w-full aspect-4/3 rounded-[10px] border-2 overflow-hidden transition-[border-color,transform] duration-fast group-active:scale-[0.98] ${
                    theme === opt.value ? "border-(--accent)" : "border-transparent group-hover:border-(--border-default)"
                  }`}
                >
                  {opt.value === "system" ? (
                    <>
                      <span className="absolute inset-0"><JanelaTema tema="light" /></span>
                      <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]"><JanelaTema tema="dark" /></span>
                    </>
                  ) : <JanelaTema tema={opt.value} />}
                  <span className="absolute bottom-1 right-1 w-5 h-5 rounded-full bg-black/35 flex items-center justify-center" aria-hidden="true">
                    <opt.icon className="w-3 h-3 text-white" />
                  </span>
                </span>
                <span className={`text-[11px] ${theme === opt.value ? "font-semibold text-(--text-primary)" : "text-(--text-secondary)"}`}>
                  {opt.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="pt-6 border-t border-(--border-default)">
          <div className="flex items-center gap-2 mb-3">
            <Rows3 className="w-4 h-4 text-(--text-accent)" />
            <h3 id="pref-dens" className="text-mac-body font-medium text-(--text-primary)">Densidade das listas</h3>
          </div>
          <div role="radiogroup" aria-labelledby="pref-dens" className="grid grid-cols-3 gap-2 max-w-[380px]">
            {DENSITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                role="radio"
                aria-checked={density === opt.value}
                onClick={() => chooseDensity(opt.value)}
                className={`flex flex-col items-center gap-1.5 py-3 rounded-(--radius-control) border text-mac-body transition-colors duration-fast ${
                  density === opt.value
                    ? "border-teal-500 bg-teal-50 dark:bg-teal-900/30 text-(--text-accent)"
                    : "border-(--border-default) text-(--text-secondary) hover:bg-(--bg-hover)"
                }`}
              >
                <opt.icon className="w-4 h-4" />
                {opt.label}
              </button>
            ))}
          </div>
          <p className="text-mac-caption text-(--text-tertiary) mt-2">
            Aplica-se à listagem de documentos.
          </p>
        </div>

        <div className="pt-6 border-t border-(--border-default)">
          <div className="flex items-center justify-between gap-4 max-w-[480px]">
            <div>
              <h3 className="text-mac-body font-medium text-(--text-primary)">Reduzir transparência</h3>
              <p className="text-mac-caption text-(--text-tertiary) mt-0.5">Troca o vidro por fundos sólidos. Segue o sistema quando ele já pede isso.</p>
            </div>
            <Switch checked={reduceTransparency} onChange={chooseReduceTransparency} label="Reduzir transparência" />
          </div>
        </div>

        <PushPreference />

        {/* Só a própria conta demo vê isso — reset também roda sozinho a cada
            24h (ver app/workers/maintenance_worker.py), este botão é só pra
            quem quiser uma demonstração limpa na hora, sem esperar o ciclo. */}
        {user?.username === "demo" && (
          <div className="pt-6">
            <DangerZone title="Dados demo"
              description="Restaura as 3 empresas de exemplo ao estado padrão, apagando qualquer documento, pasta, usuário ou link criado durante o uso. Roda sozinho a cada 6 horas; use se quiser uma demonstração limpa agora.">
              <Button variant="danger" size="sm" onClick={() => setConfirmingReset(true)}>
                <RotateCcw className="w-3.5 h-3.5" aria-hidden /> Resetar dados demo
              </Button>
            </DangerZone>
          </div>
        )}
      </div>

      {confirmingReset && (
        <ConfirmModal
          title="Resetar dados demo?"
          description="Apaga tudo que foi adicionado nas 3 empresas de exemplo (documentos, pastas, usuários, links) e recria os dados padrão. Essa ação não pode ser desfeita."
          confirmLabel="Resetar"
          danger
          loading={resetting}
          onConfirm={resetDemoData}
          onClose={() => setConfirmingReset(false)}
        />
      )}
    </div>
  );
}
