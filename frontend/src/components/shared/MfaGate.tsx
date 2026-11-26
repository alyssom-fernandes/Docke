import { useAuthContext } from "@/lib/AuthContext";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import { MfaCodeForm, MfaEnroll } from "@/components/shared/MfaSetup";

/**
 * Antes de usar o Docke: o código do app autenticador (quem já ativou) ou o
 * cadastro dele (quem a regra da empresa obriga). Não fecha: a saída é
 * concluir ou sair da conta.
 */
export default function MfaGate({ modo }: { modo: "verificar" | "cadastrar" }) {
  const { completeMfa, logout } = useAuthContext();
  return (
    <Dialog
      onClose={() => {}}
      showClose={false}
      title={modo === "verificar" ? "Verificação em duas etapas" : "Ative a verificação em duas etapas"}
      description={modo === "verificar"
        ? "Sua conta pede o código do app autenticador a cada entrada."
        : "A sua empresa pede um código do celular, além da senha, para quem administra ou vê dados pessoais. Leva um minuto."}
      size="sm"
      footer={<Button variant="ghost" onClick={logout}>Sair</Button>}
    >
      <div className="@container">
        {modo === "verificar" ? <MfaCodeForm onDone={completeMfa} /> : <MfaEnroll onDone={completeMfa} />}
      </div>
    </Dialog>
  );
}
