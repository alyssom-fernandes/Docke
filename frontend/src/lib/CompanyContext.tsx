import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import api from "@/lib/api";

/** Recursos que a empresa liga ou desliga em Ajustes → Recursos. */
export type FeatureKey = "links" | "pedidos" | "obrigacoes" | "exames" | "comentarios" | "ocr" | "canal_titular";
export type Features = Record<FeatureKey, boolean>;
export const DEFAULT_FEATURES: Features = {
  links: true, pedidos: true, obrigacoes: true, exames: true, comentarios: true, ocr: true, canal_titular: false,
};

export interface Company {
  id: string;
  name: string;
  permission_level: string;
  features?: Partial<Features>;
}

interface CompanyCtx {
  companies: Company[];
  current: Company | null;
  loading: boolean;
  setCurrent: (c: Company) => void;
  reload: () => void;
  /** Atualiza os recursos na tela logo depois de salvar (sem esperar recarregar). */
  setFeatures: (companyId: string, features: Features) => void;
}

const Ctx = createContext<CompanyCtx | null>(null);

export function CompanyProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<Company | null>(() => {
    try { return JSON.parse(localStorage.getItem("docke_company") ?? "null"); } catch { return null; }
  });

  function load() {
    if (!enabled) return;
    api.get("/companies").then((res) => {
      setCompanies(res.data);
      // Valida a empresa em cache contra a lista real — se o id salvo não
      // existe mais (empresa recriada num reseed, por exemplo), ela fica
      // presa num id morto pra sempre, já que antes só substituíamos
      // 'current' quando ele começava nulo. Revalidar aqui evita isso.
      const fresh = current ? res.data.find((c: Company) => c.id === current.id) : undefined;
      if (fresh) {
        // Mesmo id ainda válido, mas sincroniza os outros campos (ex.:
        // permission_level) — sem isso, um usuário promovido/rebaixado por
        // outro admin continuava vendo o nível de acesso antigo em telas como
        // Configurações até trocar de empresa manualmente.
        setCurrent(fresh);
        localStorage.setItem("docke_company", JSON.stringify(fresh));
      } else if (res.data.length > 0) {
        setCurrent(res.data[0]);
        localStorage.setItem("docke_company", JSON.stringify(res.data[0]));
      } else {
        setCurrent(null);
        localStorage.removeItem("docke_company");
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }

  useEffect(load, [enabled]);

  function handleSet(c: Company) {
    setCurrent(c);
    localStorage.setItem("docke_company", JSON.stringify(c));
  }

  function setFeatures(companyId: string, features: Features) {
    setCompanies((list) => list.map((c) => (c.id === companyId ? { ...c, features } : c)));
    setCurrent((c) => {
      if (!c || c.id !== companyId) return c;
      const next = { ...c, features };
      localStorage.setItem("docke_company", JSON.stringify(next));
      return next;
    });
  }

  return (
    <Ctx.Provider value={{ companies, current, loading, setCurrent: handleSet, reload: load, setFeatures }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCompany() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCompany must be inside CompanyProvider");
  return ctx;
}

/** Todos os recursos da empresa atual, com o padrão para o que não veio. */
export function useFeatures(): Features {
  const { current } = useCompany();
  return { ...DEFAULT_FEATURES, ...(current?.features ?? {}) };
}

/** Se um recurso está ligado na empresa atual. */
export function useFeature(key: FeatureKey): boolean {
  return useFeatures()[key];
}
