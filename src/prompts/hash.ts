import { createHash } from "node:crypto";

/**
 * Content hash for a prompt's static skeleton: the first 12 hex chars of its
 * SHA-256. Short enough to read in a trace/log, long enough that an accidental
 * collision between two real prompt versions is implausible. Used by the
 * registry to detect "the prompt text changed but nobody bumped the version".
 */
export function promptHash(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 12);
}
