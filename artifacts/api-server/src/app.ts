import { existsSync } from "node:fs";
import path from "node:path";
import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { weatherSchedulerRequestHook } from "./lib/weatherScheduler";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
            // Public estimate response tokens are bearer capabilities. Never
            // write them to application logs.
            // Email open-pixel tokens are the same kind of thing: anyone who
            // reads the log could mark a customer's email as opened.
            url: req.url
              ?.split("?")[0]
              .replace(/\/api\/public\/email-open\/[^/]+/, "/api/public/email-open/[REDACTED]")
              .replace(/\/api\/public\/estimates\/[^/]+/, "/api/public/estimates/[REDACTED]"),
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Credentialed CORS restricted to this app's own origins (dev + deployed).
// APP_PUBLIC_URL is the deployment's own origin; APP_EXTRA_ORIGINS is an optional
// comma-separated list for anything else that must be allowed (a second domain
// during a DNS cutover, say). Localhost is always allowed below.
const allowedOrigins = new Set<string>();
for (const value of [process.env.APP_PUBLIC_URL, ...(process.env.APP_EXTRA_ORIGINS ?? "").split(",")]) {
  const trimmed = value?.trim();
  if (!trimmed) continue;
  try {
    allowedOrigins.add(new URL(trimmed).origin);
  } catch {
    // A malformed entry must not widen CORS, and must not stop the app booting.
    logger.warn({ value: trimmed }, "ignoring unparseable allowed origin");
  }
}
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      // Same-origin/non-browser requests have no Origin header — allow them.
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      // Exact localhost hostnames only (any port), dev convenience.
      try {
        const { hostname, protocol } = new URL(origin);
        if (protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1")) {
          return callback(null, true);
        }
      } catch {
        // fall through to reject
      }
      return callback(null, false);
    },
  }),
);
// 25MB rather than the 100kb default: photos arrive base64-encoded in JSON,
// which inflates them by about a third, so the 15MB file cap in fileStorage
// needs roughly 20MB of headroom here. Without this the upload fails as a
// generic "entity too large" long before the size check that could explain it.
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Lets the daily weather check catch up on traffic when the deployment has
// been scaled to zero over the scheduled hour. Does not delay the request.
app.use(weatherSchedulerRequestHook());

app.use("/api", router);

// On Replit a workspace router served the built web app and forwarded /api to
// this process, so the browser saw one origin. Off Replit nothing does that, and
// Clerk's session cookie requires it — so in production this process serves the
// built SPA itself. In development the Vite dev server proxies /api here instead.
if (process.env.NODE_ENV === "production") {
  const webDist =
    process.env.WEB_DIST_PATH ??
    path.resolve(import.meta.dirname, "../../bison-crm/dist/public");
  const indexHtml = path.join(webDist, "index.html");

  if (existsSync(indexHtml)) {
    // index:false so the fallback below owns "/" too, and every client-side
    // route resolves through the same code path.
    app.use(express.static(webDist, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      // /api is already handled above; a miss there is a real 404, not the SPA.
      if (req.path === "/api" || req.path.startsWith("/api/")) return next();
      return res.sendFile(indexHtml);
    });
    logger.info({ webDist }, "serving web build");
  } else {
    // API-only is a valid deployment (a separate static host in front), so warn
    // rather than refuse to boot — but say so, because the usual cause is that
    // the web build did not run.
    logger.warn({ webDist }, "no web build found; serving API only");
  }
}

// Without this, anything a route throws — most commonly a request body that fails
// its schema — falls through to Express's default handler and comes back as an HTML
// 500. The client then shows a generic failure for what is really a fixable input
// problem, and a stack trace leaks into the response body.
/**
 * Recognise a schema validation error by shape rather than importing zod and using
 * `instanceof`. The generated schemas carry their own zod copy, and an `instanceof`
 * check against a second copy fails silently — turning every bad request back into
 * an opaque 500 with no sign that anything is wrong.
 */
function schemaIssues(err: unknown): { path?: unknown; message: string }[] | null {
  if (typeof err !== "object" || err === null) return null;
  const issues = (err as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  const named = issues.filter(
    (issue): issue is { path?: unknown; message: string } =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as { message?: unknown }).message === "string",
  );
  return named.length > 0 ? named : null;
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const issues = schemaIssues(err);
  if (issues) {
    const detail = issues
      .map(({ path, message }) => {
        const field = Array.isArray(path) ? path.map(String).join(".") : "";
        return field ? `${field}: ${message}` : message;
      })
      .join("; ");
    return res.status(400).json({ error: detail || "Invalid request" });
  }
  logger.error({ err }, "unhandled request error");
  if (res.headersSent) return;
  return res.status(500).json({ error: "Something went wrong. Please try again." });
});

export default app;
