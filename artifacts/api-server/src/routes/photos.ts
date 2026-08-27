import { Router, type IRouter, type Request, type Response } from "express";
import { db, jobPhotosTable, jobsTable, usersTable } from "@workspace/db";
import type { JobPhoto } from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { UploadJobPhotoBody } from "@workspace/api-zod";
import { requireAuth, requireAdmin } from "../middlewares/requireAuth";
import { logAudit } from "../lib/helpers";
import {
  MAX_UPLOAD_BYTES,
  deleteFile,
  isAllowedContentType,
  readFile,
  saveFile,
} from "../lib/fileStorage";

const router: IRouter = Router();

router.use(requireAuth);

type JobRow = typeof jobsTable.$inferSelect;

/**
 * Same rule jobs.ts applies to every other contractor action on a job. Kept as
 * a copy rather than an import because that module owns its own predicate; a
 * contractor must not be able to photograph a property he was never sent to.
 */
function canAccessJob(req: Request, job: JobRow): boolean {
  if (req.appUser?.role === "admin") return true;
  return (
    job.assignedToId === req.appUser?.id && job.dispatched === true && job.visibleToContractor === true
  );
}

async function loadAccessibleJob(req: Request, res: Response): Promise<JobRow | null> {
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, Number(req.params.id)));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return null;
  }
  if (!canAccessJob(req, job)) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return job;
}

/**
 * The bytes are only ever reachable through the authenticated route below, so
 * the path is what goes on the wire — never a storage key, which would leak the
 * layout of the file store and outlive any permission check.
 */
function contentPath(id: number): string {
  return `/api/photos/${id}/content`;
}

async function hydrate(rows: JobPhoto[]) {
  if (rows.length === 0) return [];
  const userIds = [...new Set(rows.map((r) => r.uploadedById).filter((x): x is number => x != null))];
  const users = userIds.length
    ? await db.select().from(usersTable).where(inArray(usersTable.id, userIds))
    : [];
  const uMap = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    clientId: r.clientId,
    uploadedById: r.uploadedById,
    uploadedByName: r.uploadedById ? (uMap.get(r.uploadedById) ?? null) : null,
    contentType: r.contentType,
    byteSize: r.byteSize,
    kind: r.kind,
    caption: r.caption,
    takenAt: r.takenAt.toISOString(),
    url: contentPath(r.id),
  }));
}

router.get("/jobs/:id/photos", async (req, res) => {
  const job = await loadAccessibleJob(req, res);
  if (!job) return;
  const rows = await db
    .select()
    .from(jobPhotosTable)
    .where(eq(jobPhotosTable.jobId, job.id))
    .orderBy(desc(jobPhotosTable.takenAt));
  return res.json(await hydrate(rows));
});

router.post("/jobs/:id/photos", async (req, res) => {
  const body = UploadJobPhotoBody.parse(req.body);
  const job = await loadAccessibleJob(req, res);
  if (!job) return;

  // The enum in the schema and the storage layer's own list can drift apart —
  // storage is the one that has to be able to hand the file back, so it decides.
  if (!isAllowedContentType(body.contentType)) {
    return res.status(400).json({ error: `${body.contentType} files cannot be stored` });
  }

  // A phone can send a data: URL straight out of a canvas or FileReader; the
  // prefix is not part of the payload and Buffer would decode it as garbage.
  const encoded = body.dataBase64.replace(/^data:[^;,]*;base64,/, "");
  // Checked against the encoded length first so a 20MB overshoot is rejected
  // before it is materialised into a buffer only to be thrown away.
  if (Math.floor((encoded.length * 3) / 4) > MAX_UPLOAD_BYTES) {
    return res.status(400).json({
      error: `Photo is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`,
    });
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0) {
    return res.status(400).json({ error: "Photo was empty or not valid base64" });
  }

  let stored: Awaited<ReturnType<typeof saveFile>>;
  try {
    stored = await saveFile(bytes, body.contentType);
  } catch (err) {
    // saveFile's own limits are the last word on what is storable, and a
    // rejection there is the caller's fault, not a server fault.
    req.log.warn({ err, jobId: job.id }, "photo upload rejected by file storage");
    return res.status(400).json({ error: (err as Error).message });
  }

  const photo = await db
    .insert(jobPhotosTable)
    .values({
      jobId: job.id,
      // Denormalised from the job so the office can still find the photo when
      // looking at the customer years later, whatever became of the job.
      clientId: job.clientId,
      uploadedById: req.appUser!.id,
      storageKey: stored.key,
      contentType: body.contentType,
      byteSize: stored.byteSize,
      kind: body.kind,
      caption: body.caption ?? null,
      // Stamped from this process rather than the column default: the column
      // carries no timezone, so a database session on a different zone would
      // put the wrong time under the photo.
      takenAt: new Date(),
    })
    .returning()
    .then((rows) => rows[0])
    .catch(async (err: unknown) => {
      // No row means nothing will ever point at those bytes; leaving them
      // behind fills the volume with files nothing can find or delete.
      await deleteFile(stored.key).catch(() => {});
      throw err;
    });

  await logAudit({
    clientId: job.clientId,
    actorName: req.appUser?.name,
    action: "job_photo_uploaded",
    description: `${body.kind} photo added to job #${job.id}`,
  });

  return res.status(201).json((await hydrate([photo]))[0]);
});

// Admin-only, and deliberately so: this is the office's "come back to it later"
// view of a customer, and contractors have no access to the client record it
// belongs to.
router.get("/clients/:id/photos", requireAdmin, async (req, res) => {
  const rows = await db
    .select()
    .from(jobPhotosTable)
    .where(eq(jobPhotosTable.clientId, Number(req.params.id)))
    .orderBy(desc(jobPhotosTable.takenAt));
  return res.json(await hydrate(rows));
});

/**
 * Whether this person may see the bytes behind a photo.
 *
 * The uploader keeps access to their own photo even after the job is undispatched
 * or reassigned, so the thumbnail they just took does not turn into a broken
 * image in their hand.
 */
async function canReachPhoto(req: Request, photo: JobPhoto): Promise<boolean> {
  if (req.appUser?.role === "admin") return true;
  if (photo.uploadedById != null && photo.uploadedById === req.appUser?.id) return true;
  if (photo.jobId == null) return false;
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, photo.jobId));
  return job ? canAccessJob(req, job) : false;
}

router.get("/photos/:id/content", async (req, res) => {
  const [photo] = await db
    .select()
    .from(jobPhotosTable)
    .where(eq(jobPhotosTable.id, Number(req.params.id)));
  if (!photo) return res.status(404).json({ error: "Photo not found" });
  if (!(await canReachPhoto(req, photo))) return res.status(403).json({ error: "Forbidden" });

  let bytes: Buffer;
  try {
    bytes = await readFile(photo.storageKey);
  } catch (err) {
    // A row pointing at bytes that are gone is a broken record, not a server
    // fault the caller can do anything about — but it must be findable in logs.
    req.log.error({ err, photoId: photo.id }, "stored photo bytes are missing");
    return res.status(404).json({ error: "Photo file is no longer available" });
  }

  res.setHeader("Content-Type", photo.contentType);
  res.setHeader("Content-Length", bytes.byteLength);
  // The bytes behind an id never change, so a crew scrolling a job card should
  // not re-download them over cell data. Private because these are customer
  // property records and must not land in a shared cache.
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.setHeader("Content-Disposition", "inline");
  return res.end(bytes);
});

router.delete("/photos/:id", async (req, res) => {
  const [photo] = await db
    .select()
    .from(jobPhotosTable)
    .where(eq(jobPhotosTable.id, Number(req.params.id)));
  if (!photo) return res.status(404).json({ error: "Photo not found" });

  // Narrower than viewing: admins, or the person who took it clearing up their
  // own mis-tap. A contractor must not be able to delete evidence of someone
  // else's visit.
  const isOwnUpload = photo.uploadedById != null && photo.uploadedById === req.appUser?.id;
  if (req.appUser?.role !== "admin" && !isOwnUpload) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // Row first: an orphaned file is invisible and harmless, an orphaned row is a
  // broken image in the gallery.
  await db.delete(jobPhotosTable).where(eq(jobPhotosTable.id, photo.id));
  await deleteFile(photo.storageKey);

  await logAudit({
    clientId: photo.clientId,
    actorName: req.appUser?.name,
    action: "job_photo_deleted",
    description: `${photo.kind} photo #${photo.id} deleted${photo.jobId ? ` from job #${photo.jobId}` : ""}`,
  });

  return res.status(204).end();
});

export default router;
