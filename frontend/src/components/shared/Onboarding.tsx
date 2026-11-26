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

// Mesma estrutura usada na demonstração (A1-23); dá para marcar várias.
const FOLDER_TEMPLATES = [
  { id: "fiscal", label: "Fiscal", folders: ["Notas Fiscais", "Impostos", "Declarações", "SPED"] },
  { id: "rh", label: "RH", folders: ["Admissões", "Folha de pagamento", "ASO e exames", "Desligamentos"] },
  { id: "bancario", label: "Bancário", folders: ["Extratos", "Comprovantes", "Conciliações"] },
  { id: "contratos", label: "Contratos", folders: ["Fornecedores", "Clientes", "Aluguel"] },
  { id: "licencas", label: "Licenças e certidões", folders: ["Alvarás", "AVCB", "Certidões negativas", "Licença ambiental"] },
];

const fmtCnpjInput = (v: string) => v.replace(/\D/g, "").slice(0, 14)
  .replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
  .replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d)/, "$1-$2");

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
  const [templateIds, setTemplateIds] = useState<string[]>(["fiscal", "rh", "bancario", "contratos"]);
  const [cnpj, setCnpj] = useState("");
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
      const digits = cnpj.replace(/\D/g, "");
      if (!companyId) {
        const r = await api.post("/companies", { name });
        setCompanyId(r.data.id);
        if (digits) await api.patch(`/companies/${r.data.id}`, { cnpj: digits }).catch(() => showError("Empresa criada; o CNPJ não foi salvo (confira em Ajustes → Organização)."));
      } else if (name !== savedName || digits) {
        await api.patch(`/companies/${companyId}`, { name, ...(digits ? { cnpj: digits } : {}) });
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
    const escolhidos = FOLDER_TEMPLATES.filter((t) => templateIds.includes(t.id));
    if (companyId && escolhidos.length) {
      setLoading(true);
      let falhas = 0;
      // Pasta do grupo (Fiscal, RH…) com as subpastas dentro.
      for (const t of escolhidos) {
        try {
          const r = await api.post("/folders", { name: t.label, company_id: companyId, parent_id: null });
          for (const sub of t.folders) {
            try { await api.post("/folders", { name: sub, company_id: companyId, parent_id: r.data.id }); } catch { falhas++; }
          }
        } catch { falhas++; }
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
    <Dialog onClose={() => {}} showClose={false} title={titles[step]} size="md" busy={loading} footer={footer}
      description={
        // Progresso em pontos (A1-26), com o texto para leitor de tela.
        <span className="flex items-center gap-2">
          <span className="flex gap-1.5" aria-hidden="true">
            {titles.map((_, i) => <span key={i} className={`h-1.5 rounded-full transition-all duration-200 ${i === step ? "w-5 bg-teal-600" : i < step ? "w-1.5 bg-teal-600/60" : "w-1.5 bg-(--border-control)"}`} />)}
          </span>
          <span className="text-mac-caption">Passo {step + 1} de 4</span>
        </span>
      }>
      <div key={step} className="panel-in">
      {step === 0 && (
        <p className="text-mac-body text-(--text-secondary)">Em três passos: o nome da empresa, as primeiras pastas e o que fazer em seguida. Tudo pode ser mudado depois.</p>
      )}
      {step === 1 && (
        <form onSubmit={(e) => { e.preventDefault(); saveCompany(); }} className="space-y-2">
          <Input label="Nome da empresa" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Ex.: Posto Central Ltda." maxLength={120} autoFocus />
          <Input label="CNPJ (opcional)" inputMode="numeric" value={cnpj} onChange={(e) => setCnpj(fmtCnpjInput(e.target.value))} placeholder="00.000.000/0000-00" />
          <p className="flex items-center gap-1.5 text-mac-caption text-(--text-secondary)"><Building2 className="w-3.5 h-3.5" aria-hidden="true" /> Logo e perfil fiscal (regime, segmento) ficam em Ajustes → Organização.</p>
        </form>
      )}
      {step === 2 && (
        <fieldset>
          <legend className="mb-2 text-mac-caption text-(--text-secondary)">Marque as pastas que fazem sentido; cada uma vem com as subpastas. Nenhuma marcada começa vazio.</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {FOLDER_TEMPLATES.map((t) => {
              const on = templateIds.includes(t.id);
              return (
                <button key={t.id} type="button" role="checkbox" aria-checked={on}
                  onClick={() => setTemplateIds((ids) => (on ? ids.filter((x) => x !== t.id) : [...ids, t.id]))}
                  className={`text-left rounded-(--radius-control) border p-3 min-h-16 transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${on ? "border-teal-600 bg-teal-500/10" : "border-(--border-control) hover:bg-(--bg-hover)"}`}>
                  <span className="flex items-center gap-2 text-mac-body font-medium text-(--text-primary)">
                    {on ? <Check className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> : <FolderOpen className="w-4 h-4 text-(--text-secondary)" aria-hidden="true" />}{t.label}
                  </span>
                  <span className="block text-mac-caption text-(--text-secondary)">{t.folders.join(", ")}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      {step === 3 && (
        <ul className="space-y-2">
          <li><Link to="/settings/users" onClick={finish} className="flex items-center gap-2 text-mac-body text-(--text-accent) hover:underline"><Users className="w-4 h-4" aria-hidden="true" /> Dar acesso à equipe em Pessoas e acessos</Link></li>
          <li><Link to="/obligations" onClick={finish} className="flex items-center gap-2 text-mac-body text-(--text-accent) hover:underline"><ShieldCheck className="w-4 h-4" aria-hidden="true" /> Cadastrar as obrigações com os modelos prontos</Link></li>
          <li><Link to="/documents?acao=enviar" onClick={finish} className="flex items-center gap-2 text-mac-body text-(--text-accent) hover:underline"><FolderOpen className="w-4 h-4" aria-hidden="true" /> Enviar os primeiros documentos</Link></li>
        </ul>
      )}
      </div>
    </Dialog>
  );
}
