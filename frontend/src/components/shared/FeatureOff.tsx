import { Link } from "react-router-dom";
import { PowerOff } from "lucide-react";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany } from "@/lib/CompanyContext";
import { PageHeader } from "@/components/layout/window";
import EmptyState from "@/components/shared/EmptyState";

/** Tela de um recurso desligado em Ajustes → Recursos: diz o que houve e onde religar. */
export default function FeatureOff({ title, text }: { title: string; text: string }) {
  const { current } = useCompany();
  const { user } = useAuthContext();
  const isAdmin = user?.role === "supremo" || current?.permission_level === "admin";
  return (
    <div className="max-w-[1100px] w-full mx-auto">
      <PageHeader title={title} subtitle={current?.name} />
      <EmptyState
        icon={<PowerOff />}
        title={`${title}: recurso desligado`}
        description={`${text} ${isAdmin ? "Você pode ligar de novo em Ajustes → Recursos." : "Quem administra a empresa pode ligar de novo em Ajustes → Recursos."}`}
        action={isAdmin ? (
          <Link to="/settings/features" className="inline-flex h-8 pointer-coarse:h-11 items-center rounded-full bg-(--accent) px-4 text-[13px] font-medium text-white hover:bg-(--accent-hover)">
            Abrir Recursos
          </Link>
        ) : undefined}
      />
    </div>
  );
}
