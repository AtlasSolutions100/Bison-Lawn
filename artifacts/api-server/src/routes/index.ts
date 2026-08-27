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

const router: IRouter = Router();

router.use(healthRouter);
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
router.use(webRequestsRouter);
router.use(feedbackRouter);

export default router;
