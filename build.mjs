/**
 * Production build.
 *
 * Both builds need PORT and BASE_PATH in the environment (vite.config.ts refuses
 * to load without them), and BASE_PATH is `/`. Passing that through a shell is a
 * trap on Windows — Git Bash's MSYS layer rewrites a lone `/` to the Git install
 * path, and the mangled value ends up baked into every asset URL in index.html.
 * Setting it from Node instead means no shell ever sees it.
 *
 * Usage: node build.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(root, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = {
  ...process.env,
  NODE_ENV: "production",
  BASE_PATH: "/",
  // Unused by a build, but vite.config.ts validates it before anything else.
  PORT: process.env.WEB_PORT ?? "5173",
};

function run(label, args) {
  console.log(`\n── ${label} ──`);
  const result = spawnSync("pnpm", args, {
    cwd: root,
    shell: process.platform === "win32",
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

run("typecheck", ["run", "typecheck"]);
run("web", ["--filter", "@workspace/bison-crm", "run", "build"]);
run("api", ["--filter", "@workspace/api-server", "run", "build"]);

console.log("\nBuilt. Serve with: NODE_ENV=production PORT=8080 node artifacts/api-server/dist/index.mjs");
