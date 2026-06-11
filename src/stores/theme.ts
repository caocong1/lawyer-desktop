import { createSignal, onMount } from "solid-js";

export type ThemeVariant = "a" | "b" | "c";

const STORAGE_KEY = "ml-theme";

function readStoredTheme(): ThemeVariant {
  if (typeof localStorage === "undefined") return "a";
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "a" || saved === "b" || saved === "c") return saved;
  return "a";
}

const [theme, setThemeSignal] = createSignal<ThemeVariant>(readStoredTheme());

function applyTheme(variant: ThemeVariant) {
  document.documentElement.setAttribute("data-theme", variant);
}

applyTheme(theme());

export function useTheme() {
  onMount(() => {
    applyTheme(theme());
  });

  function setTheme(variant: ThemeVariant) {
    setThemeSignal(variant);
    localStorage.setItem(STORAGE_KEY, variant);
    applyTheme(variant);
  }

  function cycleTheme() {
    const order: ThemeVariant[] = ["a", "b", "c"];
    const next = order[(order.indexOf(theme()) + 1) % order.length];
    setTheme(next);
  }

  return { theme, setTheme, cycleTheme };
}
