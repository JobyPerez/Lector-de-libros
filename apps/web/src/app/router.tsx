import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes } from "react-router-dom";

import { fetchCurrentUser } from "./api";
import { useAuthStore } from "./auth-store";
import { RabbitMark } from "../components/RabbitMark";
import { LoginPage } from "../features/auth/LoginPage";
import { BookBuilderPage } from "../features/book-builder/BookBuilderPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { ResetPasswordPage } from "../features/auth/ResetPasswordPage";
import { ShelfPage } from "../features/shelf/ShelfPage";
import { UsersAdminPage } from "../features/users/UsersAdminPage";

const queryClient = new QueryClient();

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const isHydrated = useAuthStore((state) => state.isHydrated);

  if (!isHydrated) {
    return null;
  }

  if (accessToken) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

function AdminOnlyRoute() {
  const user = useAuthStore((state) => state.user);

  if (!user) {
    return null;
  }

  if (user.role !== "ADMIN") {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}

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

  if (!user) {
    return (
      <div className="app-shell">
        <section className="panel loading-panel">
          <p className="eyebrow">Sesión</p>
          <h2>Recuperando tu biblioteca</h2>
          <p className="subdued">Estamos validando tu usuario y tus permisos.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <RabbitMark className="brand-mark" title="El conejo lector" />
          <div className="brand-copy">
            <p className="eyebrow">El conejo lector</p>
            <h1>Biblioteca hablada</h1>
          </div>
        </div>
        <nav className="topnav">
          <NavLink className={({ isActive }) => (isActive ? "topnav-link active" : "topnav-link")} to="/">
            Estantería
          </NavLink>
          <NavLink className={({ isActive }) => (isActive ? "topnav-link active" : "topnav-link")} to="/builder">
            OCR
          </NavLink>
          {user.role === "ADMIN" ? (
            <NavLink className={({ isActive }) => (isActive ? "topnav-link active" : "topnav-link")} to="/users">
              Usuarios
            </NavLink>
          ) : null}
        </nav>
        <div className="session-strip">
          <div className="user-chip">
            <strong>{user.displayName ?? user.username}</strong>
            <span>{user.email}</span>
          </div>
          <span className="role-pill">{user.role === "ADMIN" ? "Administrador" : "Editor"}</span>
          <button className="secondary-button" onClick={() => clearSession()} type="button">
            Cerrar sesión
          </button>
        </div>
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
          <Route
            path="/login"
            element={(
              <PublicOnlyRoute>
                <LoginPage />
              </PublicOnlyRoute>
            )}
          />
          <Route
            path="/reset-password"
            element={(
              <PublicOnlyRoute>
                <ResetPasswordPage />
              </PublicOnlyRoute>
            )}
          />
          <Route element={<ProtectedShell />}>
            <Route path="/" element={<ShelfPage />} />
            <Route path="/books/:bookId" element={<ReaderPage />} />
            <Route path="/builder" element={<BookBuilderPage />} />
            <Route element={<AdminOnlyRoute />}>
              <Route path="/users" element={<UsersAdminPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}