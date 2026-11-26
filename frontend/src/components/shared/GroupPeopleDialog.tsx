import { useEffect, useId, useMemo, useState } from "react";
import { Download, Search as SearchIcon, ShieldCheck, ShieldOff } from "lucide-react";
import api from "@/lib/api";
import { relativeDate } from "@/lib/date";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";

interface Pessoa {
  user_id: string; full_name: string; username: string; role: string; is_active: boolean; email: string | null;
  last_sign_in_at: string | null; mfa_enabled: boolean; companies: { company_id: string; company_name: string; role: string }[];
}

const PAPEL: Record<string, string> = { admin: "Administrador", operador: "Operador", visualizador: "Visualizador" };
const FILTROS = [
  { value: "", label: "Todas as pessoas" },
  { value: "ativas", label: "Contas ativas" },
  { value: "desativadas", label: "Contas desativadas" },
  { value: "sem_mfa", label: "Sem verificação em duas etapas" },
  { value: "nunca", label: "Nunca entraram" },
  { value: "admins", label: "Administram alguma empresa" },
];

/** Visão do grupo (FA-A9-04): todas as pessoas de todas as empresas, para o administrador geral. */
export default function GroupPeopleDialog({ onClose }: { onClose: () => void }) {
  const uid = useId();
  const [pessoas, setPessoas] = useState<Pessoa[] | null | "erro">(null);
  const [q, setQ] = useState("");
  const [filtro, setFiltro] = useState("");

  useEffect(() => {
    api.get<Pessoa[]>("/admin/people").then((r) => setPessoas(r.data)).catch(() => setPessoas("erro"));
  }, []);

  const lista = useMemo(() => {
    if (!Array.isArray(pessoas)) return [];
    const s = q.trim().toLocaleLowerCase("pt-BR");
    return pessoas.filter((p) => {
      if (filtro === "ativas" && !p.is_active) return false;
      if (filtro === "desativadas" && p.is_active) return false;
      if (filtro === "sem_mfa" && p.mfa_enabled) return false;
      if (filtro === "nunca" && p.last_sign_in_at) return false;
      if (filtro === "admins" && !p.companies.some((c) => c.role === "admin") && p.role !== "supremo") return false;
      if (!s) return true;
      return `${p.full_name} ${p.username} ${p.email ?? ""} ${p.companies.map((c) => c.company_name).join(" ")}`.toLocaleLowerCase("pt-BR").includes(s);
    });
  }, [pessoas, q, filtro]);

  function exportar() {
    const linhas = [["Pessoa", "E-mail", "Situação", "Duas etapas", "Último acesso", "Empresas (papel)"],
      ...lista.map((p) => [p.full_name, p.email ?? "", p.is_active ? "Ativa" : "Desativada", p.mfa_enabled ? "Sim" : "Não",
        p.last_sign_in_at ? new Date(p.last_sign_in_at).toLocaleString("pt-BR") : "Nunca entrou",
        p.role === "supremo" ? "Administrador geral" : p.companies.map((c) => `${c.company_name} (${PAPEL[c.role] ?? c.role})`).join(", ")])];
    const csv = "﻿" + linhas.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `pessoas-do-grupo_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <Dialog onClose={onClose} title="Pessoas de todas as empresas" size="lg"
      description="Quem tem conta no Docke, onde acessa e como está a conta. Para mudar acessos, abra a empresa em Pessoas e acessos.">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-48">
            <label htmlFor={`${uid}-q`} className="sr-only">Buscar pessoa</label>
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-(--text-secondary)" aria-hidden="true" />
            <input id={`${uid}-q`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, e-mail ou empresa"
              className="w-full h-9 pointer-coarse:h-11 pl-9 pr-3 rounded-full border border-(--border-control) bg-(--bg-card) text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
          </div>
          <div className="w-60"><Dropdown ariaLabel="Filtrar pessoas" value={filtro} onChange={setFiltro} options={FILTROS} /></div>
          <Button variant="secondary" size="sm" onClick={exportar} disabled={!lista.length}><Download className="w-3.5 h-3.5" aria-hidden="true" /> CSV</Button>
        </div>
        {pessoas === null ? <div className="h-40 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
          : pessoas === "erro" ? <p role="alert" className="text-mac-body text-(--text-danger)">Não foi possível carregar agora.</p>
          : (
            <>
              <p className="text-mac-caption text-(--text-secondary)" aria-live="polite">{lista.length} de {pessoas.length} {pessoas.length === 1 ? "pessoa" : "pessoas"}</p>
              <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default) max-h-[55vh] overflow-y-auto">
                {lista.map((p) => (
                  <li key={p.user_id} className="px-3 py-2.5 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-mac-body font-medium text-(--text-primary)">{p.full_name}</span>
                      {!p.is_active && <span className="text-mac-caption font-medium text-(--text-danger)">desativada</span>}
                      {p.mfa_enabled
                        ? <span className="inline-flex items-center gap-0.5 text-mac-caption text-(--text-success)"><ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />duas etapas</span>
                        : <span className="inline-flex items-center gap-0.5 text-mac-caption text-(--text-secondary)"><ShieldOff className="w-3.5 h-3.5" aria-hidden="true" />sem duas etapas</span>}
                      <span className="ml-auto text-mac-caption text-(--text-secondary)">{p.last_sign_in_at ? `entrou ${relativeDate(p.last_sign_in_at)}` : "nunca entrou"}</span>
                    </div>
                    <p className="text-mac-caption text-(--text-secondary) break-words">
                      {p.email}{p.email ? " · " : ""}
                      {p.role === "supremo" ? "Administrador geral" : p.companies.length ? p.companies.map((c) => `${c.company_name} (${PAPEL[c.role] ?? c.role})`).join(", ") : "sem acesso a nenhuma empresa"}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
      </div>
    </Dialog>
  );
}
