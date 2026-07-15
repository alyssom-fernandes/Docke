import { useState } from "react";
import { Anchor, Building2, FolderOpen, Users, Check, ChevronRight } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";

const ONBOARDING_KEY = "docke_onboarding_complete";

export function isOnboardingComplete(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === "true";
}

export function markOnboardingComplete() {
  localStorage.setItem(ONBOARDING_KEY, "true");
}

const FOLDER_TEMPLATES = [
  { id: "fiscal", label: "Fiscal", folders: ["Notas Fiscais", "Impostos", "Declarações"] },
  { id: "rh", label: "RH", folders: ["Contratos", "Folha de Pagamento", "Admissões"] },
  { id: "juridico", label: "Jurídico", folders: ["Contratos", "Procurações", "Certidões"] },
  { id: "none", label: "Sem template", folders: [] },
];

interface Props {
  onComplete: () => void;
}

export default function Onboarding({ onComplete }: Props) {
  const { reload } = useCompany();
  const { success, error: showError } = useToast();

  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [templateId, setTemplateId] = useState("fiscal");
  const [inviteEmail, setInviteEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [createdCompanyId, setCreatedCompanyId] = useState<string | null>(null);

  const steps = [
    { icon: Anchor, title: "Bem-vindo ao Docke", subtitle: "Gerenciamento eletrônico de documentos." },
    { icon: Building2, title: "Criar sua organização", subtitle: "Defina o nome da empresa para começar." },
    { icon: FolderOpen, title: "Estrutura de pastas", subtitle: "Escolha um template ou comece do zero." },
    { icon: Users, title: "Convidar equipe", subtitle: "Adicione membros depois, se preferir." },
  ];

  const current = steps[step];
  const StepIcon = current.icon;
  const isLast = step === steps.length - 1;

  async function handleNext() {
    if (step === 1) {
      if (!companyName.trim()) return;
      setLoading(true);
      try {
        const r = await api.post("/companies", { name: companyName.trim() });
        setCreatedCompanyId(r.data.id);
        reload();
        setStep(2);
      } catch {
        showError("Não foi possível criar a empresa. Tente novamente.");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (step === 2 && createdCompanyId) {
      const template = FOLDER_TEMPLATES.find((t) => t.id === templateId);
      if (template && template.folders.length > 0) {
        setLoading(true);
        try {
          for (const name of template.folders) {
            await api.post("/folders", { name, company_id: createdCompanyId, parent_id: null });
          }
        } catch {
          // template failure is non-blocking
        } finally {
          setLoading(false);
        }
      }
      setStep(3);
      return;
    }

    if (isLast) {
      if (inviteEmail.trim() && createdCompanyId) {
        // Best-effort invite — not blocking
        api.post(`/companies/${createdCompanyId}/invite`, { email: inviteEmail.trim() }).catch(() => {});
      }
      markOnboardingComplete();
      success("Configuração concluída! Bem-vindo ao Docke.");
      onComplete();
      return;
    }

    setStep((s) => s + 1);
  }

  return (
    <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4">
      <div className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[480px]">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2 pt-6">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-normal ${
                i === step ? "w-6 h-2 bg-teal-500" : i < step ? "w-2 h-2 bg-teal-400" : "w-2 h-2 bg-[var(--border-default)]"
              }`}
            />
          ))}
        </div>

        {/* Content */}
        <div className="px-8 py-6">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-12 h-12 bg-teal-500/10 rounded-[12px] flex items-center justify-center mb-4">
              <StepIcon className="w-6 h-6 text-teal-500" />
            </div>
            <h2 className="text-mac-title3 font-semibold text-[var(--text-primary)]">{current.title}</h2>
            <p className="text-mac-body text-[var(--text-secondary)] mt-1">{current.subtitle}</p>
          </div>

          {/* Step 0 — Welcome */}
          {step === 0 && (
            <div className="space-y-3">
              {[
                "Upload de documentos com OCR automático",
                "Busca inteligente por conteúdo",
                "Controle de acesso por pasta e empresa",
              ].map((item) => (
                <div key={item} className="flex items-center gap-3 text-mac-body text-[var(--text-primary)]">
                  <div className="w-5 h-5 bg-teal-500/10 rounded-full flex items-center justify-center flex-shrink-0">
                    <Check className="w-3 h-3 text-teal-500" />
                  </div>
                  {item}
                </div>
              ))}
            </div>
          )}

          {/* Step 1 — Company name */}
          {step === 1 && (
            <input
              autoFocus
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleNext(); }}
              placeholder="Ex: Minha Empresa Ltda."
              className="w-full h-10 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          )}

          {/* Step 2 — Folder template */}
          {step === 2 && (
            <div className="grid grid-cols-2 gap-2">
              {FOLDER_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTemplateId(t.id)}
                  className={`p-3 rounded-[var(--radius-control)] border text-left transition-all duration-fast ${
                    templateId === t.id
                      ? "border-teal-500 bg-teal-50 dark:bg-teal-900/30 text-teal-700 dark:text-teal-400"
                      : "border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  <p className="text-mac-body font-medium">{t.label}</p>
                  {t.folders.length > 0 && (
                    <p className="text-mac-caption text-[var(--text-secondary)] mt-0.5 truncate">{t.folders.join(", ")}</p>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Step 3 — Invite */}
          {step === 3 && (
            <div className="space-y-3">
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="email@colega.com (opcional)"
                className="w-full h-10 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
              />
              <p className="text-mac-caption text-[var(--text-tertiary)]">
                Você pode convidar mais pessoas depois em Configurações → Usuários.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-8 pb-6">
          {step > 0 ? (
            <button
              onClick={() => setStep((s) => s - 1)}
              className="text-mac-body text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-fast"
            >
              Voltar
            </button>
          ) : (
            <div />
          )}
          <Button onClick={handleNext} loading={loading} disabled={step === 1 && !companyName.trim()}>
            {isLast ? "Concluir" : (
              <span className="flex items-center gap-1.5">
                {step === 0 ? "Começar" : "Continuar"}
                <ChevronRight className="w-4 h-4" />
              </span>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
