import { useState } from "react";
import api from "@/lib/api";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

/**
 * Primeiro acesso com senha provisória (achado A9-16): antes de usar o
 * Docke, a pessoa cria a própria senha. Não fecha: a saída é trocar a senha
 * ou sair da conta.
 */
export default function ForcePasswordChange() {
  const { passwordChanged, logout } = useAuthContext();
  const { success, error: showError } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const errs = {
    next: next.length < 8 ? "Use ao menos 8 caracteres." : next === current ? "Escolha uma senha diferente da provisória." : "",
    again: again !== next ? "As duas senhas não são iguais." : "",
  };

  async function save() {
    setTouched(true);
    if (!current || errs.next || errs.again) return;
    setSaving(true);
    try {
      await api.post("/auth/change-password", { current_password: current, new_password: next });
      success("Senha criada. Bem-vindo ao Docke.");
      passwordChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível trocar a senha. Confira a senha provisória.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onClose={() => {}}
      showClose={false}
      title="Crie a sua senha"
      description="Você entrou com uma senha provisória. Crie a sua para continuar; ninguém mais vai saber qual é."
      size="sm"
      busy={saving}
      footer={
        <>
          <Button variant="ghost" onClick={logout}>Sair</Button>
          <Button loading={saving} onClick={save}>Salvar e continuar</Button>
        </>
      }
    >
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Senha provisória" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
        <Input label="Nova senha" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={touched ? errs.next : undefined} />
        <Input label="Repita a nova senha" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} error={touched ? errs.again : undefined} />
        <button type="submit" className="sr-only">Salvar</button>
      </form>
    </Dialog>
  );
}
