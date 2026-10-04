import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * On Windows pnpm is `pnpm.cmd`, which bare spawn cannot resolve: it fails with
 * ENOENT and the suite then times out waiting for a Vite that never booted.
 * Routing through the shell there is what makes the name resolvable.
 */
const SPAWN_THROUGH_SHELL = process.platform === "win32";
import { createServer } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

const repoRoot = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export type StubForecast = {
  precipitationMm: number;
  windKph: number;
  maxTempC: number;
  minTempC: number;
};

let stubForecast: StubForecast | null = null;

/**
 * Weather forecasts are stubbed for browser tests so a rule either fires or
 * doesn't regardless of the real weather (and without calling Open-Meteo).
 * Pass `null` to make an unexpected forecast lookup fail loudly.
 */
export function setStubForecast(forecast: StubForecast | null): void {
  stubForecast = forecast;
}

function installForecastStub(): void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (url.includes("api.open-meteo.com")) {
      if (!stubForecast) {
        throw new Error("e2e: forecast requested but no stub forecast is configured");
      }
      const body = {
        daily: {
          precipitation_sum: [stubForecast.precipitationMm],
          wind_speed_10m_max: [stubForecast.windKph],
          temperature_2m_max: [stubForecast.maxTempC],
          temperature_2m_min: [stubForecast.minTempC],
        },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

/**
 * The suite runs against the development database, which drifts from the
 * Drizzle schema whenever new columns land. Syncing first keeps the suite
 * self-contained instead of failing with opaque 500s from the API.
 */
async function syncDatabaseSchema(): Promise<void> {
  await new Promise<void>((resolve) => {
    const push = spawn("pnpm", ["--filter", "db", "push", "--force"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      shell: SPAWN_THROUGH_SHELL,
    });
    let out = "";
    push.stdout?.on("data", (c) => (out += String(c)));
    push.stderr?.on("data", (c) => (out += String(c)));
    push.on("close", (code) => {
      if (code !== 0) {
        console.warn(`[e2e] schema push exited with ${code}; continuing.\n${out.slice(-1000)}`);
      }
      resolve();
    });
    push.on("error", (err) => {
      console.warn(`[e2e] could not run schema push: ${String(err)}`);
      resolve();
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (typeof address === "string" || !address) return reject(new Error("no port"));
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

export type Harness = {
  /** Origin of the Vite dev server; /api is proxied to the test API server. */
  webUrl: string;
  apiUrl: string;
  /** Browser context that authenticates every request as the given app user. */
  contextForUser: (userId: number) => Promise<BrowserContext>;
  close: () => Promise<void>;
};

/**
 * Boots an isolated stack for browser tests:
 *   - the real Express API in-process with `NODE_ENV=test` and a random
 *     `TEST_AUTH_TOKEN`, so requests authenticate via the existing test-only
 *     header bypass in requireAuth (no Clerk session involved);
 *   - a Vite dev server for the web app with `VITE_E2E_AUTH_BYPASS=1`, which
 *     skips only the client-side Clerk gate, and `/api` proxied to the API;
 *   - a headless Chromium from the workspace-provided Playwright build.
 */
export async function startHarness(): Promise<Harness> {
  await syncDatabaseSchema();
  process.env.NODE_ENV = "test";
  const testAuthToken = `e2e_${Math.random().toString(36).slice(2)}${Date.now()}`;
  process.env.TEST_AUTH_TOKEN = testAuthToken;
  installForecastStub();

  const { default: app } = await import("@workspace/api-server/src/app.ts");
  const apiServer: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const apiAddress = apiServer.address();
  if (typeof apiAddress === "string" || !apiAddress) throw new Error("API server has no port");
  const apiUrl = `http://127.0.0.1:${apiAddress.port}`;

  const webPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  const vite: ChildProcess = spawn(
    "pnpm",
    ["--filter", "@workspace/bison-crm", "exec", "vite", "--config", "vite.config.ts", "--host", "127.0.0.1"],
    {
      cwd: repoRoot,
      // A process group is a POSIX idea; on Windows the whole tree is killed
      // through taskkill in close() instead.
      detached: !SPAWN_THROUGH_SHELL,
      stdio: ["ignore", "pipe", "pipe"],
      shell: SPAWN_THROUGH_SHELL,
      env: {
        ...process.env,
        NODE_ENV: "development",
        PORT: String(webPort),
        BASE_PATH: "/",
        E2E_API_URL: apiUrl,
        VITE_E2E_AUTH_BYPASS: "1",
      },
    },
  );
  let viteOutput = "";
  vite.stdout?.on("data", (c) => (viteOutput += String(c)));
  vite.stderr?.on("data", (c) => (viteOutput += String(c)));

  // Replit supplied a Chromium build via REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE.
  // Off-platform, prefer PLAYWRIGHT_CHROMIUM_EXECUTABLE if set and otherwise let
  // Playwright resolve the browser it installed itself (`pnpm exec playwright
  // install chromium`), which is the normal case on a developer machine or CI.
  const executablePath =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ??
    process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE;

  let browser: Browser | null = null;
  const contexts: BrowserContext[] = [];

  const close = async () => {
    for (const ctx of contexts) await ctx.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (vite.pid) {
      if (SPAWN_THROUGH_SHELL) {
        // vite is a grandchild of the shell, so killing the shell alone would
        // leave it running and holding the port for the next run.
        spawnSync("taskkill", ["/T", "/F", "/PID", String(vite.pid)], { stdio: "ignore" });
      } else {
        try {
          process.kill(-vite.pid, "SIGTERM");
        } catch {
          vite.kill("SIGTERM");
        }
      }
    }
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  };

  try {
    await waitForHttp(webUrl, 90_000);
    browser = await chromium.launch({
      // Undefined means "use Playwright's own installed Chromium".
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (err) {
    await close();
    throw new Error(`${String(err)}\nVite output:\n${viteOutput.slice(-2000)}`);
  }

  return {
    webUrl,
    apiUrl,
    async contextForUser(userId: number) {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
      // Only same-origin API calls carry the test capability token: as a
      // context-wide header it would also be sent to Clerk, fonts and any other
      // third-party origin the page touches.
      await context.route(`${webUrl}/api/**`, (route) =>
        route.continue({
          headers: {
            ...route.request().headers(),
            "x-test-user-id": String(userId),
            "x-test-auth-token": testAuthToken,
          },
        }),
      );
      context.setDefaultTimeout(30_000);
      context.on("console", (msg) => {
        if (msg.type() === "error") console.error(`[browser] ${msg.text()}`);
      });
      contexts.push(context);
      return context;
    },
    close,
  };
}
