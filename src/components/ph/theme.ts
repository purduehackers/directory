export type Theme = "light" | "dark";

export const THEME_KEY = "ph-theme";

export function getSystemTheme(): Theme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined" || !window.localStorage) {
    return null;
  }
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {}
  return null;
}

export function getTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const isDark = theme === "dark";
  document.documentElement.classList.toggle("dark", isDark);

  try {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    if (meta) {
      const stored = getStoredTheme();
      meta.content = stored ? theme : "light dark";
    }
  } catch {}
}

export function setTheme(theme: Theme | null) {
  if (typeof window === "undefined") return;
  try {
    if (theme) {
      localStorage.setItem(THEME_KEY, theme);
    } else {
      localStorage.removeItem(THEME_KEY);
    }
  } catch {}
  applyTheme(getTheme());
}

export function toggleTheme() {
  const current = getTheme();
  const next: Theme = current === "dark" ? "light" : "dark";
  const system = getSystemTheme();

  // If next theme matches system preference, clear stored override (revert to following system)
  if (next === system) {
    setTheme(null);
  } else {
    setTheme(next);
  }
}

// Inline in <head> so the page never flashes the wrong theme.
export const themeScript = `try{var k="${THEME_KEY}",s=localStorage.getItem(k),t=(s==="light"||s==="dark")?s:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.classList.toggle("dark",t==="dark");var m=document.querySelector('meta[name="color-scheme"]');if(m)m.content=s?t:"light dark";}catch(e){}`;
