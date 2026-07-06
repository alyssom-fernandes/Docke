import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import api from "@/lib/api";

export interface Company {
  id: string;
  name: string;
  permission_level: string;
}

interface CompanyCtx {
  companies: Company[];
  current: Company | null;
  loading: boolean;
  setCurrent: (c: Company) => void;
  reload: () => void;
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
      const stillValid = current && res.data.some((c: Company) => c.id === current.id);
      if (!stillValid && res.data.length > 0) {
        setCurrent(res.data[0]);
        localStorage.setItem("docke_company", JSON.stringify(res.data[0]));
      } else if (!stillValid) {
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

  return (
    <Ctx.Provider value={{ companies, current, loading, setCurrent: handleSet, reload: load }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCompany() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCompany must be inside CompanyProvider");
  return ctx;
}
