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
  setCurrent: (c: Company) => void;
  reload: () => void;
}

const Ctx = createContext<CompanyCtx | null>(null);

export function CompanyProvider({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [current, setCurrent] = useState<Company | null>(() => {
    try { return JSON.parse(localStorage.getItem("docke_company") ?? "null"); } catch { return null; }
  });

  function load() {
    if (!enabled) return;
    api.get("/companies").then((res) => {
      setCompanies(res.data);
      if (!current && res.data.length > 0) {
        setCurrent(res.data[0]);
        localStorage.setItem("docke_company", JSON.stringify(res.data[0]));
      }
    }).catch(() => {});
  }

  useEffect(load, [enabled]);

  function handleSet(c: Company) {
    setCurrent(c);
    localStorage.setItem("docke_company", JSON.stringify(c));
  }

  return (
    <Ctx.Provider value={{ companies, current, setCurrent: handleSet, reload: load }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCompany() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useCompany must be inside CompanyProvider");
  return ctx;
}
