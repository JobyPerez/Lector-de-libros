import { create } from "zustand";

const accessTokenKey = "lector.accessToken";
const refreshTokenKey = "lector.refreshToken";

export type UserRole = "ADMIN" | "EDITOR";

export type UserAiCredentialSummary = {
  awsRegion: string | null;
  deepgramTtsModel: string;
  deepgramTtsModelIt?: string;
  hasAwsAccessKeyId: boolean;
  hasAwsCredentials: boolean;
  hasAwsSecretAccessKey: boolean;
  hasDeepgramApiKey: boolean;
  hasOpencodeApiKey?: boolean;
  hasGeminiApiKey?: boolean;
  opencodeOcrModel?: string | null;
  opencodeSummaryModel?: string | null;
  opencodeOcrVisibleModels?: string[];
  opencodeSummaryVisibleModels?: string[];
  shareAws?: boolean;
  shareOpencode?: boolean;
  shareGoogle?: boolean;
  shareDeepgram?: boolean;
  shareOpencodeOcr?: boolean;
  shareOpencodeSummary?: boolean;
  usingSharedAws?: boolean;
  usingSharedOpencode?: boolean;
  usingSharedOpencodeOcr?: boolean;
  usingSharedOpencodeSummary?: boolean;
  usingSharedGoogle?: boolean;
  usingSharedDeepgram?: boolean;
  sharedAwsBy?: string | null;
  sharedOpencodeBy?: string | null;
  sharedOpencodeOcrBy?: string | null;
  sharedOpencodeSummaryBy?: string | null;
  sharedGoogleBy?: string | null;
  sharedDeepgramBy?: string | null;
  hasEffectiveAws?: boolean;
  hasEffectiveOpencode?: boolean;
  hasEffectiveOpencodeOcr?: boolean;
  hasEffectiveOpencodeSummary?: boolean;
  hasEffectiveGoogle?: boolean;
  hasEffectiveDeepgram?: boolean;
};

import type { ThemeMode, ThemePalette } from "./api";

export type SessionUser = {
  aiCredentials?: UserAiCredentialSummary;
  displayName: string | null;
  email: string;
  role: UserRole;
  themeMode?: ThemeMode;
  themePalette?: ThemePalette;
  userId: string;
  username: string;
};

type AuthState = {
  accessToken: string | null;
  isHydrated: boolean;
  refreshToken: string | null;
  user: SessionUser | null;
  clearSession: () => void;
  hydrateFromStorage: () => void;
  setSession: (session: { accessToken: string; refreshToken: string; user: SessionUser }) => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  isHydrated: false,
  refreshToken: null,
  user: null,
  clearSession: () => {
    localStorage.removeItem(accessTokenKey);
    localStorage.removeItem(refreshTokenKey);
    set({ accessToken: null, isHydrated: true, refreshToken: null, user: null });
  },
  hydrateFromStorage: () => {
    const accessToken = localStorage.getItem(accessTokenKey);
    const refreshToken = localStorage.getItem(refreshTokenKey);

    if (!accessToken || !refreshToken) {
      set({ isHydrated: true });
      return;
    }

    set({ accessToken, isHydrated: true, refreshToken });
  },
  setSession: ({ accessToken, refreshToken, user }) => {
    localStorage.setItem(accessTokenKey, accessToken);
    localStorage.setItem(refreshTokenKey, refreshToken);
    set({ accessToken, isHydrated: true, refreshToken, user });
  }
}));
