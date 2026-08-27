/**
 * Local development runner.
 *
 * Replit provided two things this repo cannot assume off-platform: environment
 * variables injected into every process, and a workspace proxy that served the
 * web app and the API from one origin. This script replaces both — it loads
 * `.env`, starts the API on API_PORT, and starts Vite on WEB_PORT with `/api`
 * proxied to the API so the browser still sees a single origin (cookie auth
 * depends on that).
 *
 * Usage: node dev.mjs            (both processes)
 *        node dev.mjs api        (API only)
 *        node dev.mjs web        (web only)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");

if (!existsSync(envFile)) {
  console.error("Missing .env — copy .env.example to .env and fill it in.");
  process.exit(1);
}
process.loadEnvFile(envFile);

for (const key of ["DATABASE_URL", "CLERK_SECRET_KEY", "VITE_CLERK_PUBLISHABLE_KEY"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key} (see .env.example)`);
    process.exit(1);
  }
}

const apiPort = process.env.API_PORT ?? "3001";
const webPort = process.env.WEB_PORT ?? "5173";
const basePath = process.env.BASE_PATH ?? "/";

const which = process.argv[2] ?? "all";
const children = [];

function run(name, color, args, env) {
  const child = spawn("pnpm", args, {
    cwd: root,
    // pnpm resolves through a shell script on Windows.
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) out.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
  });
  children.push(child);
  return child;
}

if (which === "all" || which === "api") {
  run("api", "36", ["--filter", "@workspace/api-server", "run", "dev"], {
    PORT: apiPort,
    NODE_ENV: "development",
  });
}

if (which === "all" || which === "web") {
  run("web", "35", ["--filter", "@workspace/bison-crm", "exec", "vite", "--config", "vite.config.ts"], {
    PORT: webPort,
    BASE_PATH: basePath,
    NODE_ENV: "development",
    // vite.config.ts only mounts the /api proxy when this is set. Cookie auth
    // needs one origin, and off Replit nothing else routes /api for us.
    API_URL: `http://127.0.0.1:${apiPort}`,
  });
}

const shutdown = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
