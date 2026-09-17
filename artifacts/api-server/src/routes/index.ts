import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import clientsRouter from "./clients";
import clientServicesRouter from "./client-services";
import jobProductsRouter from "./job-products";
import clientsBulkRouter from "./clients-bulk";
import clientContactsRouter from "./client-contacts";
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
import clientActivityRouter from "./client-activity";
import routeBuilderRouter from "./route-builder";
import reportsRouter from "./reports";
import searchRouter from "./search";
import dispatchMapRouter from "./dispatch-map";
import smsRouter from "./sms";
import locationsRouter from "./locations";
import dispatchActionsRouter from "./dispatch-actions";
import emailActivityRouter from "./email-activity";

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
// Same again: the email open pixel at /public/email-open/:token is fetched by
// the customer's mail client with no session. The activity endpoints in the
// same router guard themselves by path.
router.use(emailActivityRouter);
// Same again: smsRouter carries the public texting webhook at
// /public/sms/inbound, which the provider signs instead of holding a session.
// Its authed paths are guarded per route inside the router.
router.use(smsRouter);
// Ahead of automationRouter, whose blanket requireAuth+requireAdmin would turn
// a contractor's phone reporting to /my/location into a 403. Every route in
// here carries its own guard, so mounting it early widens nothing.
router.use(locationsRouter);
router.use(usersRouter);
// Before clientsRouter: it registers /clients/:id, which would swallow
// /clients/export as a client id and 404. The bulk router carries its own
// requireAuth + requireAdmin guard.
router.use(clientsBulkRouter);
// Also before clientsRouter, so a contacts request is authenticated once by its
// own guard instead of twice (clientsRouter guards everything under /clients).
router.use(clientContactsRouter);
router.use(clientsRouter);
// Right after clientsRouter, whose guard on /clients and /client-services is
// what makes the assigned-service routes admin-only.
router.use(clientServicesRouter);
router.use(jobProductsRouter);
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
router.use(clientActivityRouter);
router.use(routeBuilderRouter);
router.use(dispatchMapRouter);
router.use(dispatchActionsRouter);
router.use(reportsRouter);
router.use(searchRouter);
router.use(settingsRouter);

export default router;
