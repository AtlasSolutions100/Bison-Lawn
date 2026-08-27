/**
 * Where uploaded bytes live.
 *
 * Disk-backed, under a Docker volume, rather than object storage: one client on
 * one box, photos measured in gigabytes not terabytes, and a volume is already
 * backed up with the database. The seam below is the whole point — every caller
 * goes through saveFile/readFile/deleteFile and never builds a path, so moving
 * to S3 later is this file and nothing else.
 *
 * Nothing here is served directly by a static handler. Photos are customer
 * property records; they are read back through an authenticated route that
 * checks who is asking, which a static mount cannot do.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile as fsReadFile, unlink, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const ROOT = resolve(process.env.FILE_STORAGE_DIR?.trim() || "/data/uploads");

/** 15 MB. A modern phone photo is 3–8 MB; this leaves room without inviting video. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Only formats a browser will render inline and a mail client will show.
 * HEIC is deliberately absent: iPhones convert on upload through a file input,
 * and accepting it would mean shipping a converter to make it viewable anywhere.
 */
const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export function isAllowedContentType(contentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXTENSION_BY_TYPE, contentType);
}

export function allowedContentTypes(): string[] {
  return Object.keys(EXTENSION_BY_TYPE);
}

/**
 * Resolve a stored key to an absolute path, refusing anything that escapes the
 * root.
 *
 * Keys come out of the database, and a row could hold "../../etc/passwd" if
 * anything ever wrote one — so this checks the resolved path rather than
 * trusting the string. Containment is asserted with the separator appended, or
 * a sibling directory named like the root ("/data/uploads-evil") would pass a
 * bare startsWith.
 */
function resolveKey(key: string): string {
  const full = resolve(join(ROOT, key));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    throw new Error("Refusing to touch a file outside the storage root");
  }
  return full;
}

/**
 * Store bytes and return the key to get them back.
 *
 * Keyed by date then random id: the date keeps directories small enough to list
 * during an incident, and the random id means a key can never be guessed from a
 * job or client id — an authorised reader has the key, a curious one cannot
 * derive it.
 */
export async function saveFile(
  bytes: Buffer,
  contentType: string,
): Promise<{ key: string; byteSize: number; sha256: string }> {
  const extension = EXTENSION_BY_TYPE[contentType];
  if (!extension) throw new Error(`Unsupported file type: ${contentType}`);
  if (bytes.byteLength === 0) throw new Error("Refusing to store an empty file");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error(`File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit`);
  }

  const now = new Date();
  const key = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    `${randomUUID()}.${extension}`,
  ].join("/");

  const full = resolveKey(key);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes);

  return {
    key,
    byteSize: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function readFile(key: string): Promise<Buffer> {
  return fsReadFile(resolveKey(key));
}

export async function fileExists(key: string): Promise<boolean> {
  try {
    await stat(resolveKey(key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort delete. A missing file is success: the caller's intent is that the
 * bytes are gone, and failing here would strand the database row that points at
 * them, which is the worse of the two states.
 */
export async function deleteFile(key: string): Promise<void> {
  try {
    await unlink(resolveKey(key));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** Where the files are, for a startup log line that makes a misconfigured volume obvious. */
export function storageRoot(): string {
  return ROOT;
}
