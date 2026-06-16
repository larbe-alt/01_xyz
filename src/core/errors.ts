import { NordError } from "@n1xyz/nord-ts";

export type ErrorKind = "retryable" | "rejected" | "fatal";

export interface ClassifiedError {
  kind: ErrorKind;
  original: unknown;
  message: string;
}

const RETRYABLE_PATTERNS = [
  /nonce/i,
  /timeout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /fetch failed/i,
  /network/i,
  /503/,
  /502/,
  /429/,
];

const FATAL_STATUS_CODES = new Set([401, 403]);

function matchesRetryablePattern(message: string): boolean {
  return RETRYABLE_PATTERNS.some((pat) => pat.test(message));
}

export function classifyError(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof NordError) {
    if (err.statusCode && FATAL_STATUS_CODES.has(err.statusCode)) {
      return { kind: "fatal", original: err, message };
    }
    if (err.statusCode && (err.statusCode >= 500 || err.statusCode === 429)) {
      return { kind: "retryable", original: err, message };
    }
  }

  if (matchesRetryablePattern(message)) {
    return { kind: "retryable", original: err, message };
  }

  return { kind: "rejected", original: err, message };
}

export function isRetryable(err: unknown): boolean {
  return classifyError(err).kind === "retryable";
}
