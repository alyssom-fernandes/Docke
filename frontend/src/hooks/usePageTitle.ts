import { useEffect } from "react";

export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · Docke` : "Docke";
    return () => { document.title = "Docke"; };
  }, [title]);
}
