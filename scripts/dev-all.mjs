import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

const processes = [];
let shuttingDown = false;

function prefixOutput(label, stream, writer) {
  let buffer = "";

  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      writer(`[${label}] ${line}\n`);
    }
  });

  stream.on("end", () => {
    if (buffer.length > 0) {
      writer(`[${label}] ${buffer}\n`);
      buffer = "";
    }
  });
}

function runProcess(label, scriptName) {
  const child = spawn(`npm run ${scriptName}`, {
    cwd: process.cwd(),
    env: process.env,
    shell: true,
    stdio: ["inherit", "pipe", "pipe"]
  });

  prefixOutput(label, child.stdout, (message) => process.stdout.write(message));
  prefixOutput(label, child.stderr, (message) => process.stderr.write(message));

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    const reason = signal ? `senal ${signal}` : `codigo ${code ?? 0}`;
    process.stderr.write(`[${label}] finalizo con ${reason}.\n`);
    void shutdown(code ?? 1);
  });

  processes.push(child);
  return child;
}

function waitForPort(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port }, () => {
        socket.end();
        resolve();
      });

      socket.once("error", () => {
        socket.destroy();

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`El puerto ${port} no estuvo disponible tras ${timeoutMs} ms.`));
          return;
        }

        setTimeout(attempt, 300);
      });
    };

    attempt();
  });
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of processes) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const child of processes) {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }

    process.exit(exitCode);
  }, 1_500).unref();

  process.exit(exitCode);
}

process.on("SIGINT", () => {
  void shutdown(0);
});

process.on("SIGTERM", () => {
  void shutdown(0);
});

async function start() {
  runProcess("api", "dev:api");
  runProcess("worker", "dev:worker");

  process.stdout.write("[dev-all] Esperando a que el API abra el puerto 3000...\n");
  await waitForPort(3000, 120_000);
  process.stdout.write("[dev-all] API disponible en http://localhost:3000. Iniciando web...\n");

  runProcess("web", "dev:web");
}

void start().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[dev-all] ${message}\n`);
  void shutdown(1);
});