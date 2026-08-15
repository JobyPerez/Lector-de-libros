import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { updateCurrentUserProfile, type ThemeMode, type ThemePalette } from "./api";
import { useAuthStore } from "./auth-store";

export const THEME_MODE_STORAGE_KEY = "lector.themeMode";
export const THEME_PALETTE_STORAGE_KEY = "lector.themePalette";

export type EffectiveThemeMode = "light" | "dark";

export type PaletteOption = {
  id: ThemePalette;
  name: string;
  subtitle: string;
  description: string;
  previewColors: [string, string, string, string]; // [primary, accent, backgroundLight, backgroundDark]
};

export const AVAILABLE_PALETTES: readonly PaletteOption[] = [
  {
    id: "default",
    name: "Por defecto",
    subtitle: "Bosque & Ámbar",
    description: "La paleta original cálida con verdes bosque, papel pergamino y acentos ámbar.",
    previewColors: ["#2a5742", "#d98941", "#fff7ec", "#13231b"]
  },
  {
    id: "ocean",
    name: "Océano",
    subtitle: "Azul & Pizarra",
    description: "Azules nórdicos profundos, pizarra fresca y acentos cian cristalinos.",
    previewColors: ["#1e537d", "#0284c7", "#f0f6fa", "#0c1b29"]
  },
  {
    id: "amethyst",
    name: "Amatista",
    subtitle: "Violeta & Ciruela",
    description: "Púrpura refinado con notas de ciruela mística y lavanda suave.",
    previewColors: ["#5e3596", "#a855f7", "#f7f2fc", "#1a102b"]
  },
  {
    id: "coffee",
    name: "Café",
    subtitle: "Sepia & Espresso",
    description: "Tonos tostados de café, papel sepia suave y reflejos de caramelo.",
    previewColors: ["#633d24", "#d97736", "#fbf5ee", "#22160f"]
  },
  {
    id: "graphite",
    name: "Grafito",
    subtitle: "Monocromo & Neutro",
    description: "Gris neutro moderno, carbón equilibrado y acentos plateados nítidos.",
    previewColors: ["#475569", "#0ea5e9", "#f4f6f8", "#14181f"]
  }
] as const;

export type ModeOption = {
  id: ThemeMode;
  label: string;
  icon: string;
  description: string;
};

export const AVAILABLE_MODES: readonly ModeOption[] = [
  {
    id: "light",
    label: "Claro",
    icon: "☀️",
    description: "Tonos diurnos óptimos para lectura iluminada."
  },
  {
    id: "dark",
    label: "Oscuro",
    icon: "🌙",
    description: "Tonos oscuros relajantes para ambientes con poca luz."
  },
  {
    id: "system",
    label: "Automático",
    icon: "💻",
    description: "Sincronizado con la preferencia de tu sistema."
  }
] as const;

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function isThemePalette(value: string | null): value is ThemePalette {
  return AVAILABLE_PALETTES.some((palette) => palette.id === value);
}

function getSystemMode(): EffectiveThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveEffectiveMode(preference: ThemeMode): EffectiveThemeMode {
  if (preference === "system") {
    return getSystemMode();
  }
  return preference;
}

function applyThemeToDocument(effectiveMode: EffectiveThemeMode, preference: ThemeMode, palette: ThemePalette) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.setAttribute("data-theme-mode", effectiveMode);
  root.setAttribute("data-theme-preference", preference);
  root.setAttribute("data-theme-palette", palette);

  // Update theme-color meta for browser chrome / status bar
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  if (themeColorMeta) {
    const paletteOption = AVAILABLE_PALETTES.find((item) => item.id === palette) || AVAILABLE_PALETTES[0]!;
    const headerColor = effectiveMode === "dark" ? paletteOption.previewColors[3] : paletteOption.previewColors[0];
    themeColorMeta.setAttribute("content", headerColor);
  }
}

type ThemeContextValue = {
  mode: ThemeMode;
  palette: ThemePalette;
  effectiveMode: EffectiveThemeMode;
  saveStatus: "idle" | "saving" | "saved" | "error";
  saveError: string | null;
  setMode: (nextMode: ThemeMode) => Promise<void>;
  setPalette: (nextPalette: ThemePalette) => Promise<void>;
  setTheme: (nextMode: ThemeMode, nextPalette: ThemePalette) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
      if (isThemeMode(stored)) {
        return stored;
      }
    }
    return "system";
  });

  const [palette, setPaletteState] = useState<ThemePalette>(() => {
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(THEME_PALETTE_STORAGE_KEY);
      if (isThemePalette(stored)) {
        return stored;
      }
    }
    return "default";
  });

  const [systemIsDark, setSystemIsDark] = useState<boolean>(() => {
    return typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)").matches : false;
  });

  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  const authUser = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);

  // Calculate effective mode
  const effectiveMode: EffectiveThemeMode = useMemo(() => {
    if (mode === "system") {
      return systemIsDark ? "dark" : "light";
    }
    return mode;
  }, [mode, systemIsDark]);

  // Synchronize when OS dark/light mode preference changes
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (event: MediaQueryListEvent) => {
      setSystemIsDark(event.matches);
    };

    setSystemIsDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, []);

  // Synchronize DOM attributes whenever effectiveMode or palette changes
  useEffect(() => {
    applyThemeToDocument(effectiveMode, mode, palette);
  }, [effectiveMode, mode, palette]);

  // Synchronize when authenticated user profile changes
  useEffect(() => {
    if (!authUser) {
      return;
    }

    if (authUser.themeMode && isThemeMode(authUser.themeMode) && authUser.themeMode !== mode) {
      setModeState(authUser.themeMode);
      window.localStorage.setItem(THEME_MODE_STORAGE_KEY, authUser.themeMode);
    }

    if (authUser.themePalette && isThemePalette(authUser.themePalette) && authUser.themePalette !== palette) {
      setPaletteState(authUser.themePalette);
      window.localStorage.setItem(THEME_PALETTE_STORAGE_KEY, authUser.themePalette);
    }
  }, [authUser?.userId, authUser?.themeMode, authUser?.themePalette]);

  const persistTheme = useCallback(
    async (nextMode: ThemeMode, nextPalette: ThemePalette) => {
      // 1. Immediately apply to local state & localStorage
      setModeState(nextMode);
      setPaletteState(nextPalette);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(THEME_MODE_STORAGE_KEY, nextMode);
        window.localStorage.setItem(THEME_PALETTE_STORAGE_KEY, nextPalette);
      }

      // 2. If logged in, automatically save in the background
      if (accessToken && authUser) {
        setSaveStatus("saving");
        setSaveError(null);
        try {
          const response = await updateCurrentUserProfile(accessToken, {
            email: authUser.email,
            themeMode: nextMode,
            themePalette: nextPalette
          });

          useAuthStore.setState((previous) => ({
            ...previous,
            user: response.user
          }));

          setSaveStatus("saved");
          setTimeout(() => {
            setSaveStatus("idle");
          }, 2500);
        } catch (error) {
          setSaveStatus("error");
          setSaveError(error instanceof Error ? error.message : "Error al guardar el tema");
        }
      }
    },
    [accessToken, authUser]
  );

  const setMode = useCallback(
    async (nextMode: ThemeMode) => {
      await persistTheme(nextMode, palette);
    },
    [palette, persistTheme]
  );

  const setPalette = useCallback(
    async (nextPalette: ThemePalette) => {
      await persistTheme(mode, nextPalette);
    },
    [mode, persistTheme]
  );

  const value = useMemo(
    () => ({
      mode,
      palette,
      effectiveMode,
      saveStatus,
      saveError,
      setMode,
      setPalette,
      setTheme: persistTheme
    }),
    [mode, palette, effectiveMode, saveStatus, saveError, setMode, setPalette, persistTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
