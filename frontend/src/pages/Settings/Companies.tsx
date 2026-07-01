import { useCompany } from "@/lib/CompanyContext";
import { usePageTitle } from "@/hooks/usePageTitle";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";
import { Building2 } from "lucide-react";

export default function Companies() {
  usePageTitle("Empresas");
  const { companies, current, setCurrent } = useCompany();

  return (
    <div className="max-w-[700px] mx-auto space-y-6">
      <h1 className="text-xl font-semibold text-[var(--text-primary)]">Empresas</h1>

      {companies.length === 0 ? (
        <EmptyState
          title="Nenhuma empresa"
          description="Você não tem acesso a nenhuma empresa ainda."
          icon={<Building2 className="w-6 h-6" />}
        />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
          <ul>
            {companies.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-3 px-5 py-4 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{c.name}</p>
                  <p className="text-xs text-[var(--text-secondary)]">
                    {{ viewer: "Visualizador", editor: "Editor", manager: "Gerente" }[c.permission_level] ?? c.permission_level}
                  </p>
                </div>
                {current?.id === c.id && <Badge variant="teal">Ativa</Badge>}
                {current?.id !== c.id && (
                  <button
                    onClick={() => setCurrent(c)}
                    className="text-xs text-teal-600 hover:underline"
                  >
                    Selecionar
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
