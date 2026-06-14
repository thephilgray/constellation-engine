import { useEffect, useState } from "react";

/** Subscribe to a CSS media query. SSR-safe (defaults to `false`). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The design's mobile breakpoint (< 880px). Drives the Draft insert menu. */
export const useIsMobile = () => useMediaQuery("(max-width: 879px)");
