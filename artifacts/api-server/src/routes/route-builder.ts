import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

// Stub created during phase 1 so route registration is not a contended file.
// Implementation follows in this module only.
router.use(requireAuth);

export default router;
