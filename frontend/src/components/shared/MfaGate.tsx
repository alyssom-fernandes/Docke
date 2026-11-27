import { useState } from "react";
import { useAuthContext } from "@/lib/AuthContext";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import { MfaCodeForm, MfaEnroll, MfaRecoverForm } from "@/components/shared/MfaSetup";

/**
 * Antes de usar o Docke: o código do app autenticador (quem já ativou) ou o
 * cadastro dele (quem a regra da empresa obriga). Não fecha: a saída é
 * concluir ou sair da conta.
 */
export default function MfaGate({ modo }: { modo: "verificar" | "cadastrar" }) {
  const { completeMfa, logout } = useAuthContext();
  const [recuperar, setRecuperar] = useState(false);
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
        {modo === "verificar" ? (recuperar ? <MfaRecoverForm onCancel={() => setRecuperar(false)} /> : (
          <>
            <MfaCodeForm onDone={completeMfa} />
            <button type="button" onClick={() => setRecuperar(true)} className="mt-3 w-full text-mac-caption text-(--text-accent) hover:underline">
              Perdi o celular: usar um código de recuperação
            </button>
          </>
        )) : <MfaEnroll onDone={completeMfa} />}
      </div>
    </Dialog>
  );
}
