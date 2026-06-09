import { createSignal, onMount } from "solid-js";

type Theme = "light" | "dark";

const [theme, setThemeSignal] = createSignal<Theme>("light");

export function useTheme() {
  onMount(() => {
    const saved = localStorage.getItem("theme") as Theme | null;
    if (saved) {
      setThemeSignal(saved);
    } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      setThemeSignal("dark");
    }
    applyTheme();
  });

  function setTheme(t: Theme) {
    setThemeSignal(t);
    localStorage.setItem("theme", t);
    applyTheme();
  }

  function toggleTheme() {
    setTheme(theme() === "light" ? "dark" : "light");
  }

  function applyTheme() {
    document.documentElement.setAttribute("data-theme", theme());
  }

  return { theme, setTheme, toggleTheme };
}
