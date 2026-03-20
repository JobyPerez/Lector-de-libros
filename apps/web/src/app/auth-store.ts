import { create } from "zustand";

const accessTokenKey = "lector.accessToken";
const refreshTokenKey = "lector.refreshToken";

export type UserRole = "ADMIN" | "EDITOR";

export type SessionUser = {
  displayName: string | null;
  email: string;
  role: UserRole;
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