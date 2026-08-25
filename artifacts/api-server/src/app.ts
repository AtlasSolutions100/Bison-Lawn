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
            url: req.url
              ?.split("?")[0]
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
const allowedOrigins = new Set<string>();
for (const domain of (process.env.REPLIT_DOMAINS ?? "").split(",")) {
  if (domain.trim()) allowedOrigins.add(`https://${domain.trim()}`);
}
if (process.env.REPLIT_DEV_DOMAIN) {
  allowedOrigins.add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
