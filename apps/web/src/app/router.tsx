import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { BrowserRouter, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigationType, useOutlet } from "react-router-dom";

import { fetchCurrentUser } from "./api";
import { useAuthStore, type SessionUser } from "./auth-store";
import { RabbitMark } from "../components/RabbitMark";
import { LoginPage } from "../features/auth/LoginPage";
import { BookBuilderPage } from "../features/book-builder/BookBuilderPage";
import { AiRequestsPage } from "../features/reader/AiRequestsPage";
import { OutlineEditorPage } from "../features/reader/OutlineEditorPage";
import { ReaderPage } from "../features/reader/ReaderPage";
import { ResetPasswordPage } from "../features/auth/ResetPasswordPage";
import { SearchPage } from "../features/search/SearchPage";
import { ShelfPage } from "../features/shelf/ShelfPage";
import { UsersAdminPage } from "../features/users/UsersAdminPage";

const queryClient = new QueryClient();
const routerBaseName = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";
const routeTransitionDurationMs = 320;
const madridDateTimeFormatter = new Intl.DateTimeFormat("es-ES", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Madrid"
});

type RouteTransitionDirection = "back" | "forward";
type AnimatedOutletScreen = {
  direction: RouteTransitionDirection;
  key: string;
  node: React.ReactNode;
  phase: "enter" | "exit" | "idle";
};

function formatMadridDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Fecha no disponible";
  }

  return madridDateTimeFormatter.format(date);
}

function buildRouteTransitionKey(location: ReturnType<typeof useLocation>) {
  return `${location.pathname}${location.hash}`;
}

function RouteScene({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const direction: RouteTransitionDirection = navigationType === "POP" ? "back" : "forward";

  return (
    <div className="route-scene" data-direction={direction} key={buildRouteTransitionKey(location)}>
      {children}
    </div>
  );
}

function AnimatedRouteOutlet() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const outlet = useOutlet();
  const [screens, setScreens] = useState<Array<AnimatedOutletScreen>>(() => [{
    direction: "forward",
    key: buildRouteTransitionKey(location),
    node: outlet,
    phase: "idle"
  }]);

  useEffect(() => {
    const nextKey = buildRouteTransitionKey(location);
    const direction: RouteTransitionDirection = navigationType === "POP" ? "back" : "forward";

    setScreens((current) => {
      const activeScreen = current[current.length - 1];

      if (!activeScreen || activeScreen.key === nextKey) {
        return [{
          direction,
          key: nextKey,
          node: outlet,
          phase: activeScreen?.phase === "enter" ? "enter" : "idle"
        }];
      }

      return [
        {
          ...activeScreen,
          direction,
          phase: "exit"
        },
        {
          direction,
          key: nextKey,
          node: outlet,
          phase: "enter"
        }
      ];
    });

    const timeoutId = window.setTimeout(() => {
      setScreens((current) => {
        const activeScreen = current[current.length - 1];

        if (!activeScreen || activeScreen.key !== nextKey) {
          return current;
        }

        return [{ ...activeScreen, phase: "idle" }];
      });
    }, routeTransitionDurationMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [location.hash, location.key, location.pathname, location.search, navigationType, outlet]);

  return (
    <div className="route-transition-shell">
      {screens.map((screen) => (
        <div className="route-transition-screen" data-direction={screen.direction} data-phase={screen.phase} key={screen.key}>
          {screen.node}
        </div>
      ))}
    </div>
  );
}

function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const accessToken = useAuthStore((state) => state.accessToken);
  const isHydrated = useAuthStore((state) => state.isHydrated);

  if (!isHydrated) {
    return null;
  }

  if (accessToken) {
    return <Navigate to="/" replace />;
  }

  return <RouteScene>{children}</RouteScene>;
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

function ProfileIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 12C14.7614 12 17 9.76142 17 7C17 4.23858 14.7614 2 12 2C9.23858 2 7 4.23858 7 7C7 9.76142 9.23858 12 12 12Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
      <path d="M20 21C20 17.6863 16.4183 15 12 15C7.58172 15 4 17.6863 4 21" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
}

function VersionActivity() {
  const [isOpen, setIsOpen] = useState(false);
  const activityRef = useRef<HTMLSpanElement>(null);
  const versionLabel = `v${__APP_VERSION__}`;
  const branchLabel = __APP_BRANCH__ && __APP_BRANCH__ !== "main" ? __APP_BRANCH__ : "";
  const buildTimeLabel = formatMadridDateTime(__APP_BUILD_TIME__);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      if (event.target instanceof Node && activityRef.current?.contains(event.target)) {
        return;
      }

      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <span className="version-activity" ref={activityRef}>
      <button
        aria-expanded={isOpen}
        aria-label={`Ver actividad de ${versionLabel}`}
        className="app-version"
        onClick={() => setIsOpen((current) => !current)}
        title={branchLabel ? `Ver actividad de ${versionLabel} en ${branchLabel}` : `Ver actividad de ${versionLabel}`}
        type="button"
      >
        {versionLabel}
      </button>
      <span className="build-time">Build: {buildTimeLabel}</span>

      {isOpen ? (
        <div className="version-activity-panel">
          <div className="version-activity-header">
            <strong>Actividad reciente</strong>
            {branchLabel ? <span>Rama {branchLabel}</span> : null}
          </div>
          {__APP_RECENT_COMMITS__.length > 0 ? (
            <ol className="commit-list">
              {__APP_RECENT_COMMITS__.map((commit) => (
                <li className="commit-list-item" key={commit.hash}>
                  <span className="commit-subject" title={commit.subject}>{commit.subject}</span>
                  <span className="commit-meta">
                    {commit.authorName} · {commit.shortHash} · {formatMadridDateTime(commit.authoredAt)}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="commit-empty">No hay commits disponibles en este build.</p>
          )}
        </div>
      ) : null}
    </span>
  );
}

function ProfileMenu({ onLogout, user }: { onLogout: () => void; user: SessionUser }) {
  const [isOpen, setIsOpen] = useState(false);
  const displayName = user.displayName ?? user.username;
  const roleLabel = user.role === "ADMIN" ? "Administrador" : "Editor";

  return (
    <div className="profile-menu">
      <button
        aria-expanded={isOpen}
        aria-label="Abrir menú de perfil"
        className="profile-trigger"
        onClick={() => setIsOpen((current) => !current)}
        title="Perfil"
        type="button"
      >
        <ProfileIcon />
      </button>

      {isOpen ? (
        <div className="profile-panel">
          <div className="profile-panel-row">
            <strong>Nombre</strong>
            <span>{displayName}</span>
          </div>
          <div className="profile-panel-row">
            <strong>Correo</strong>
            <span>{user.email}</span>
          </div>
          <div className="profile-panel-row">
            <strong>Perfil</strong>
            <span>{roleLabel}</span>
          </div>
          <button className="danger-button" onClick={() => {
            setIsOpen(false);
            onLogout();
          }} type="button">
            Cerrar sesión
          </button>
        </div>
      ) : null}
    </div>
  );
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
            <p className="eyebrow">
              El conejo lector <VersionActivity />
            </p>
            <h1>Biblioteca contada</h1>
          </div>
        </div>
        <nav className="topnav">
          <NavLink className={({ isActive }) => (isActive ? "topnav-link active" : "topnav-link")} to="/">
            Estantería
          </NavLink>
          {user.role === "ADMIN" ? (
            <NavLink className={({ isActive }) => (isActive ? "topnav-link active" : "topnav-link")} to="/users">
              Usuarios
            </NavLink>
          ) : null}
        </nav>
        <div className="topbar-actions">
          <ProfileMenu onLogout={clearSession} user={user} />
        </div>
      </header>
      <main>
        <AnimatedRouteOutlet />
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
      <BrowserRouter basename={routerBaseName}>
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
            <Route path="/search" element={<SearchPage />} />
            <Route path="/books/:bookId" element={<ReaderPage />} />
            <Route path="/books/:bookId/ai-requests" element={<AiRequestsPage />} />
            <Route path="/books/:bookId/outline/edit" element={<OutlineEditorPage />} />
            <Route path="/books/:bookId/sections/:chapterId/ai-requests" element={<AiRequestsPage />} />
            <Route path="/books/:bookId/sections/:chapterId/summary" element={<AiRequestsPage />} />
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
