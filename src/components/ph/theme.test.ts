import { describe, it, expect, beforeEach } from "bun:test";
import {
  getTheme,
  getSystemTheme,
  getStoredTheme,
  setTheme,
  toggleTheme,
  applyTheme,
  THEME_KEY,
} from "./theme";

describe("Theme Management Utility", () => {
  let store: Record<string, string> = {};
  let systemPrefersDark = false;
  let docClasses: Set<string> = new Set();
  let metaContent = "";

  beforeEach(() => {
    store = {};
    systemPrefersDark = false;
    docClasses = new Set();
    metaContent = "";

    // Mock localStorage
    const mockStorage = {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, val: string) => {
        store[key] = String(val);
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        store = {};
      },
    };

    // Mock matchMedia
    const mockMatchMedia = (query: string) => ({
      matches: query.includes("prefers-color-scheme: dark") ? systemPrefersDark : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });

    // Mock document
    const mockDoc = {
      documentElement: {
        classList: {
          toggle: (cls: string, force?: boolean) => {
            if (force === undefined) {
              if (docClasses.has(cls)) docClasses.delete(cls);
              else docClasses.add(cls);
            } else if (force) {
              docClasses.add(cls);
            } else {
              docClasses.delete(cls);
            }
          },
          contains: (cls: string) => docClasses.has(cls),
        },
      },
      querySelector: (selector: string) => {
        if (selector.includes('meta[name="color-scheme"]')) {
          return {
            get content() {
              return metaContent;
            },
            set content(val: string) {
              metaContent = val;
            },
          };
        }
        return null;
      },
    };

    // Assign mocks to globalThis
    (globalThis as any).localStorage = mockStorage;
    (globalThis as any).matchMedia = mockMatchMedia;
    (globalThis as any).document = mockDoc;
    (globalThis as any).window = {
      localStorage: mockStorage,
      matchMedia: mockMatchMedia,
    };
  });

  it("defaults to system theme when no stored preference exists", () => {
    systemPrefersDark = false;
    expect(getTheme()).toBe("light");

    systemPrefersDark = true;
    expect(getTheme()).toBe("dark");
  });

  it("uses stored preference if valid", () => {
    systemPrefersDark = true;
    store[THEME_KEY] = "light";
    expect(getTheme()).toBe("light");

    systemPrefersDark = false;
    store[THEME_KEY] = "dark";
    expect(getTheme()).toBe("dark");
  });

  it("applies theme by setting class on documentElement and updating meta tag", () => {
    // When dark is applied with no stored preference
    applyTheme("dark");
    expect(docClasses.has("dark")).toBe(true);
    expect(metaContent).toBe("light dark");

    // When dark is stored and applied
    store[THEME_KEY] = "dark";
    applyTheme("dark");
    expect(docClasses.has("dark")).toBe(true);
    expect(metaContent).toBe("dark");

    // When light is stored and applied
    store[THEME_KEY] = "light";
    applyTheme("light");
    expect(docClasses.has("dark")).toBe(false);
    expect(metaContent).toBe("light");
  });

  it("toggles theme and reverts override when matching system preference", () => {
    // System is light
    systemPrefersDark = false;

    // First toggle: light -> dark (differs from system -> stored as dark)
    toggleTheme();
    expect(getStoredTheme()).toBe("dark");
    expect(docClasses.has("dark")).toBe(true);
    expect(metaContent).toBe("dark");

    // Second toggle: dark -> light (matches system -> override is cleared/unpinned)
    toggleTheme();
    expect(getStoredTheme()).toBeNull();
    expect(docClasses.has("dark")).toBe(false);
    expect(metaContent).toBe("light dark");
  });

  it("allows setting theme to null to reset to system default", () => {
    store[THEME_KEY] = "dark";
    systemPrefersDark = false;

    setTheme(null);
    expect(getStoredTheme()).toBeNull();
    expect(getTheme()).toBe("light");
    expect(docClasses.has("dark")).toBe(false);
    expect(metaContent).toBe("light dark");
  });
});
