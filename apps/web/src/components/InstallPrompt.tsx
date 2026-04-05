import { useEffect, useMemo, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type NavigatorWithStandalone = Navigator & {
  standalone?: boolean;
};

type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (listener: (event: MediaQueryListEvent) => void) => void;
  removeListener?: (listener: (event: MediaQueryListEvent) => void) => void;
};

function isStandaloneMode() {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia("(display-mode: standalone)").matches || Boolean((window.navigator as NavigatorWithStandalone).standalone);
}

function detectInstallEnvironment() {
  if (typeof navigator === "undefined") {
    return {
      isFirefox: false,
      isIos: false,
      isMobile: false,
      isSafari: false
    };
  }

  const userAgent = navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/iu.test(userAgent);
  const isFirefox = /Firefox|FxiOS/iu.test(userAgent);
  const isSafari = /Safari/iu.test(userAgent) && !/Chrome|CriOS|Edg|OPR|Android/iu.test(userAgent);
  const isMobile = isIos || /Android/iu.test(userAgent);

  return {
    isFirefox,
    isIos,
    isMobile,
    isSafari
  };
}

export function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isHelpVisible, setIsHelpVisible] = useState(false);
  const [isInstalled, setIsInstalled] = useState(isStandaloneMode);

  const environment = useMemo(() => detectInstallEnvironment(), []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const displayModeMedia = window.matchMedia("(display-mode: standalone)") as LegacyMediaQueryList;

    function syncInstalledState() {
      setIsInstalled(isStandaloneMode());
    }

    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    }

    function handleAppInstalled() {
      setDeferredPrompt(null);
      setIsHelpVisible(false);
      syncInstalledState();
    }

    syncInstalledState();
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    if (typeof displayModeMedia.addEventListener === "function") {
      displayModeMedia.addEventListener("change", syncInstalledState);
    } else if (typeof displayModeMedia.addListener === "function") {
      displayModeMedia.addListener(syncInstalledState);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);

      if (typeof displayModeMedia.removeEventListener === "function") {
        displayModeMedia.removeEventListener("change", syncInstalledState);
      } else if (typeof displayModeMedia.removeListener === "function") {
        displayModeMedia.removeListener(syncInstalledState);
      }
    };
  }, []);

  if (isInstalled) {
    return <span className="install-badge">Instalada</span>;
  }

  const canPromptInstall = Boolean(deferredPrompt);

  async function handleInstallClick() {
    if (!deferredPrompt) {
      setIsHelpVisible((current) => !current);
      return;
    }

    await deferredPrompt.prompt();
    const choiceResult = await deferredPrompt.userChoice;

    if (choiceResult.outcome === "accepted") {
      setDeferredPrompt(null);
      setIsHelpVisible(false);
    }
  }

  let helpText = "En Chrome o Edge usa el botón de instalar del navegador si no aparece el aviso automático.";

  if (environment.isIos && environment.isSafari) {
    helpText = "En Safari para iPhone o iPad abre Compartir y toca Añadir a pantalla de inicio.";
  } else if (environment.isSafari) {
    helpText = "En Safari para macOS usa Archivo y luego Añadir al Dock para instalar esta web como app.";
  } else if (environment.isFirefox && environment.isMobile) {
    helpText = "En Firefox para Android abre el menú del navegador y usa Instalar o Añadir a pantalla de inicio.";
  } else if (environment.isFirefox) {
    helpText = "Firefox en escritorio no ofrece instalación PWA completa. Para instalar en PC usa Chrome, Edge o Safari.";
  }

  return (
    <div className="install-prompt-shell">
      <button className="install-button" onClick={() => void handleInstallClick()} type="button">
        {canPromptInstall ? "Instalar app" : "Cómo instalar"}
      </button>
      {isHelpVisible ? (
        <div className="install-help" role="status">
          <strong>Instalación</strong>
          <p>{helpText}</p>
          <p className="install-help-subtle">La versión instalada abre a pantalla completa y guarda mejor la sesión en móvil.</p>
        </div>
      ) : null}
    </div>
  );
}