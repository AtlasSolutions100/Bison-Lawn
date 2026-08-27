import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import clientsRouter from "./clients";
import servicesRouter from "./services";
import estimatesRouter from "./estimates";
import jobsRouter from "./jobs";
import billingRouter from "./billing";
import ticketsRouter from "./tickets";
import fieldNotesRouter from "./field-notes";
import automationRouter from "./automation";
import dashboardRouter from "./dashboard";
import vendorRunsRouter from "./vendor-runs";
import lettersRouter from "./letters";
import webRequestsRouter from "./web-requests";
import feedbackRouter from "./feedback";
import settingsRouter from "./settings";
import quickbooksRouter from "./quickbooks";
import timeTrackingRouter from "./time-tracking";
import photosRouter from "./photos";
import routeBuilderRouter from "./route-builder";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
// Ahead of jobsRouter, which is the first router to apply requireAuth to every
// request that reaches it. The QuickBooks OAuth callback has to stay reachable
// without a session — Intuit sends the browser to it, not the app.
router.use(quickbooksRouter);
// Same reason, and it cost a real outage: webRequestsRouter carries the public
// Squarespace webhook at /inbound/web-request, which authenticates with a shared
// secret header instead of a session. Mounted after jobsRouter it was shadowed
// by that blanket requireAuth, so every form submission got 401 no matter what
// secret was sent — the router's own guard on /web-requests never got a say.
// Its authed paths are guarded inside the router by path, so mounting it early
// widens nothing.
router.use(webRequestsRouter);
router.use(usersRouter);
router.use(clientsRouter);
router.use(servicesRouter);
router.use(estimatesRouter);
router.use(jobsRouter);
router.use(billingRouter);
router.use(ticketsRouter);
router.use(fieldNotesRouter);
router.use(automationRouter);
router.use(dashboardRouter);
router.use(vendorRunsRouter);
router.use(lettersRouter);
router.use(feedbackRouter);
router.use(timeTrackingRouter);
router.use(photosRouter);
router.use(routeBuilderRouter);
router.use(reportsRouter);
router.use(settingsRouter);

export default router;
