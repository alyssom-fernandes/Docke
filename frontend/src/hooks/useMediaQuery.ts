import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = () => setMatches(mql.matches);
    setMatches(mql.matches);
    // O resize cobre os ambientes em que o "change" da media query não chega.
    mql.addEventListener("change", handler);
    window.addEventListener("resize", handler);
    return () => { mql.removeEventListener("change", handler); window.removeEventListener("resize", handler); };
  }, [query]);

  return matches;
}
