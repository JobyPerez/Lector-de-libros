import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";

import { fetchCurrentUser } from "./api";
import { useAuthStore } from "./auth-store";
import { LoginPage } from "../features/auth/LoginPage";
import { BookBuilderPage } from "../features/book-builder/BookBuilderPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { ShelfPage } from "../features/shelf/ShelfPage";

const queryClient = new QueryClient();

function ProtectedShell() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const isHydrated = useAuthStore((state) => state.isHydrated);
  const user = useAuthStore((state) => state.user);
  const clearSession = useAuthStore((state) => state.clearSession);

  useEffect(() => {
    if (!accessToken || user) {
      return;
    }

    fetchCurrentUser(accessToken)
      .then((response) => {
        useAuthStore.setState((previous) => ({ ...previous, user: response.user }));
      })
      .catch(() => {
        clearSession();
      });
  }, [accessToken, clearSession, user]);

  if (!isHydrated) {
    return null;
  }

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Biblioteca hablada</p>
          <h1>Lector de libros</h1>
        </div>
        <button className="secondary-button" onClick={() => clearSession()} type="button">
          Cerrar sesión
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function StartupHydrator() {
  const hydrateFromStorage = useAuthStore((state) => state.hydrateFromStorage);

  useEffect(() => {
    hydrateFromStorage();
  }, [hydrateFromStorage]);

  return null;
}

export function AppRouter() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <StartupHydrator />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedShell />}>
            <Route path="/" element={<ShelfPage />} />
            <Route path="/books/:bookId" element={<ReaderPage />} />
            <Route path="/builder" element={<BookBuilderPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}