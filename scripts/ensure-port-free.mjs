import net from "node:net";

const [portArg, serviceName = "servicio"] = process.argv.slice(2);

if (!portArg) {
  console.error("Uso: node scripts/ensure-port-free.mjs <puerto> [nombre-servicio]");
  process.exit(1);
}

const port = Number(portArg);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Puerto invalido: ${portArg}`);
  process.exit(1);
}

function isAddressInUse(error) {
  return error && typeof error === "object" && "code" in error && (error.code === "EADDRINUSE" || error.code === "EACCES");
}

async function detectRunningLectorApi(portNumber) {
  try {
    const response = await fetch(`http://127.0.0.1:${portNumber}/health`);
    if (!response.ok) {
      return false;
    }

    const payload = await response.json().catch(() => null);
    return payload?.service === "lector-api";
  } catch {
    return false;
  }
}

async function ensurePortFree(portNumber, name) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (isAddressInUse(error)) {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.listen(portNumber, "0.0.0.0", () => {
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(true);
      });
    });
  }).then(async (isFree) => {
    if (isFree) {
      return;
    }

    const lectorApiRunning = await detectRunningLectorApi(portNumber);
    const details = lectorApiRunning
      ? `Ya hay una instancia de El conejo lector escuchando en http://localhost:${portNumber}.`
      : `El puerto ${portNumber} ya esta ocupado por otro proceso.`;

    console.error(`${details} Deten el proceso actual o cambia el puerto antes de iniciar ${name}.`);
    process.exit(1);
  });
}

void ensurePortFree(port, serviceName).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`No se pudo validar el puerto ${port}: ${message}`);
  process.exit(1);
});
