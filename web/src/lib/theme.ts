import { useState } from "react";

export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("baton.theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
    setDark(next);
  };
  return { dark, toggle };
}
