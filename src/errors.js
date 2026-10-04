// Shared error type for natl. Parent-owned: no subagent writes this file.
//
// Rationale for a single module instead of one per package: four separate
// tasks needed NatlError at the same time, and a per-module copy would have
// created four `class NatlError extends Error` declarations that fail
// `instanceof` checks across module boundaries. One definition, imported
// everywhere, keeps `err instanceof NatlError` true project-wide.

export class NatlError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NatlError';
    // `details` carries machine-readable context (status, provider, raw body)
    // so callers can branch on it without parsing the message.
    this.details = details;
  }
}

/**
 * True only for errors raised by natl itself.
 * External failures (ECONNREFUSED, ETIMEDOUT, EPIPE) keep their own name so
 * a driver can distinguish "the protocol rejected us" from "the wire broke".
 */
export const isNatlError = (err) => err instanceof NatlError;

/**
 * Render any thrown value as a single-line diagnostic. Never throws itself.
 * Used by the report layer so one bad error shape cannot crash reporting.
 */
export function describeError(err) {
  if (err == null) return String(err);
  if (typeof err === 'string') return err;
  const name = err.name || 'Error';
  const msg = err.message || String(err);
  return `${name}: ${msg}`;
}

export default NatlError;