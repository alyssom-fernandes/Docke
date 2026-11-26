import { useState } from "react";
import { Link } from "react-router-dom";
import { Building2, FolderOpen, Check, ShieldCheck, Users } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";

const ONBOARDING_KEY = "docke_onboarding_complete";

export function isOnboardingComplete(): boolean {
  return localStorage.getItem(ONBOARDING_KEY) === "true";
}

export function markOnboardingComplete() {
  localStorage.setItem(ONBOARDING_KEY, "true");
}

const FOLDER_TEMPLATES = [
  { id: "fiscal", label: "Fiscal", folders: ["Notas Fiscais", "Impostos", "Declarações"] },
  { id: "rh", label: "RH", folders: ["Contratos de trabalho", "Folha de pagamento", "Admissões"] },
  { id: "juridico", label: "Jurídico", folders: ["Contratos", "Procurações", "Certidões"] },
  { id: "none", label: "Começar sem pastas", folders: [] },
];

/**
 * Primeiro acesso (A1-20, A1-21, A1-24): em Dialog acessível; a empresa é
 * criada uma vez só (voltar e avançar edita o nome em vez de criar outra);
 * sem o convite que chamava uma rota inexistente: o último passo leva a
 * "Pessoas e acessos" e às obrigações prontas. Quem não é administrador
 * geral não cria empresa: vê que ainda não tem acesso e a quem pedir.
 */
export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  const { reload } = useCompany();
  const { user, logout } = useAuthContext();
  const { success, error: showError } = useToast();
  const [step, setStep] = useState(0);
  const [companyName, setCompanyName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [templateId, setTemplateId] = useState("fiscal");
  const [loading, setLoading] = useState(false);
  const [companyId, setCompanyId] = useState<string | null>(null);

  if (user?.role !== "supremo") {
    return (
      <Dialog onClose={() => {}} showClose={false} title="Você ainda não tem acesso a uma empresa" size="sm"
        description="Sua conta está ativa, mas nenhuma empresa foi liberada para você."
        footer={<><Button variant="ghost" onClick={logout}>Sair</Button><Button onClick={() => { reload(); }}>Conferir de novo</Button></>}>
        <p className="text-mac-body text-(--text-secondary)">Peça a quem administra a empresa para dar acesso a você em Ajustes → Pessoas e acessos. Depois, clique em “Conferir de novo”.</p>
      </Dialog>
    );
  }

  async function saveCompany() {
    const name = companyName.trim();
    if (!name) return;
    setLoading(true);
    try {
      if (!companyId) {
        const r = await api.post("/companies", { name });
        setCompanyId(r.data.id);
      } else if (name !== savedName) {
        await api.patch(`/companies/${companyId}`, { name });
      }
      setSavedName(name);
      reload();
      setStep(2);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar a empresa. Tente de novo.");
    } finally {
      setLoading(false);
    }
  }

  async function createFolders() {
    const template = FOLDER_TEMPLATES.find((t) => t.id === templateId);
    if (companyId && template && template.folders.length) {
      setLoading(true);
      let falhas = 0;
      for (const name of template.folders) {
        try { await api.post("/folders", { name, company_id: companyId, parent_id: null }); } catch { falhas++; }
      }
      setLoading(false);
      if (falhas) showError(`${falhas} ${falhas === 1 ? "pasta não foi criada" : "pastas não foram criadas"} (talvez já existam). Dá para criar depois em Documentos.`);
    }
    setStep(3);
  }

  function finish() {
    markOnboardingComplete();
    success("Tudo pronto. Bem-vindo ao Docke.");
    onComplete();
  }

  const titles = ["Bem-vindo ao Docke", "Sua empresa", "Pastas para começar", "Próximos passos"];
  const footer = (
    <>
      {step > 0 && step < 3 && <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={loading}>Voltar</Button>}
      {step === 0 && <Button onClick={() => setStep(1)}>Começar</Button>}
      {step === 1 && <Button loading={loading} disabled={!companyName.trim()} onClick={saveCompany}>Continuar</Button>}
      {step === 2 && <Button loading={loading} onClick={createFolders}>Continuar</Button>}
      {step === 3 && <Button onClick={finish}>Ir para o Início</Button>}
    </>
  );

  return (
    <Dialog onClose={() => {}} showClose={false} title={titles[step]} description={`Passo ${step + 1} de 4`} size="md" busy={loading} footer={footer}>
      {step === 0 && (
        <p className="text-mac-body text-(--text-secondary)">Em três passos: o nome da empresa, as primeiras pastas e o que fazer em seguida. Tudo pode ser mudado depois.</p>
      )}
      {step === 1 && (
        <form onSubmit={(e) => { e.preventDefault(); saveCompany(); }} className="space-y-2">
          <Input label="Nome da empresa" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Ex.: Posto Central Ltda." maxLength={120} autoFocus />
          <p className="flex items-center gap-1.5 text-mac-caption text-(--text-secondary)"><Building2 className="w-3.5 h-3.5" aria-hidden="true" /> CNPJ, logo e perfil fiscal ficam em Ajustes → Organização.</p>
        </form>
      )}
      {step === 2 && (
        <div role="radiogroup" aria-label="Modelo de pastas" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {FOLDER_TEMPLATES.map((t) => (
            <button key={t.id} type="button" role="radio" aria-checked={templateId === t.id} onClick={() => setTemplateId(t.id)}
              className={`text-left rounded-(--radius-control) border p-3 min-h-16 transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${templateId === t.id ? "border-teal-600 bg-teal-500/10" : "border-(--border-control) hover:bg-(--bg-hover)"}`}>
              <span className="flex items-center gap-2 text-mac-body font-medium text-(--text-primary)">
                {templateId === t.id ? <Check className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> : <FolderOpen className="w-4 h-4 text-(--text-secondary)" aria-hidden="true" />}{t.label}
              </span>
              {t.folders.length > 0 && <span className="block text-mac-caption text-(--text-secondary)">{t.folders.join(", ")}</span>}
            </button>
          ))}
        </div>
      )}
      {step === 3 && (
        <ul className="space-y-2">
          <li><Link to="/settings/users" onClick={finish} className="flex items-center gap-2 text-mac-body text-(--text-accent) hover:underline"><Users className="w-4 h-4" aria-hidden="true" /> Dar acesso à equipe em Pessoas e acessos</Link></li>
          <li><Link to="/obligations" onClick={finish} className="flex items-center gap-2 text-mac-body text-(--text-accent) hover:underline"><ShieldCheck className="w-4 h-4" aria-hidden="true" /> Cadastrar as obrigações com os modelos prontos</Link></li>
          <li><Link to="/documents?acao=enviar" onClick={finish} className="flex items-center gap-2 text-mac-body text-(--text-accent) hover:underline"><FolderOpen className="w-4 h-4" aria-hidden="true" /> Enviar os primeiros documentos</Link></li>
        </ul>
      )}
    </Dialog>
  );
}
