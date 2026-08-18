import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import clientsRouter from "./clients";
import servicesRouter from "./services";
import estimatesRouter from "./estimates";
import jobsRouter from "./jobs";
import billingRouter from "./billing";
import ticketsRouter from "./tickets";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(clientsRouter);
router.use(servicesRouter);
router.use(estimatesRouter);
router.use(jobsRouter);
router.use(billingRouter);
router.use(ticketsRouter);
router.use(dashboardRouter);

export default router;
