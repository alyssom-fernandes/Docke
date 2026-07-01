import { Shield } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import Badge from "@/components/ui/Badge";

const ROLES = [
  {
    role: "viewer",
    label: "Visualizador",
    description: "Pode ver e baixar documentos, mas não pode criar, mover ou excluir.",
  },
  {
    role: "editor",
    label: "Editor",
    description: "Pode criar pastas, fazer upload, mover e renomear documentos.",
  },
  {
    role: "manager",
    label: "Gerente",
    description: "Acesso completo incluindo exclusão permanente e gestão de usuários.",
  },
];

export default function Permissions() {
  usePageTitle("Permissões");
  return (
    <div className="max-w-[700px] mx-auto space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">Permissões</h1>

      <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--border-default)] flex items-center gap-2">
          <Shield className="w-4 h-4 text-teal-600" />
          <h2 className="text-sm font-medium text-[var(--text-primary)]">Níveis de acesso</h2>
        </div>
        <ul>
          {ROLES.map((r) => (
            <li key={r.role} className="flex items-start gap-4 px-5 py-4 border-b border-[var(--border-default)] last:border-0">
              <Badge variant={r.role === "manager" ? "teal" : r.role === "editor" ? "info" : "default"}>
                {r.label}
              </Badge>
              <p className="text-sm text-[var(--text-secondary)]">{r.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
