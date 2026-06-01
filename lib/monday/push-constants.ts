/** Shared Push-to-Monday constants that are safe to import from both the
 *  server (push-lead.ts, leads/actions.ts) and client components (the lead
 *  detail drawer's textarea maxLength). Kept separate from push-lead.ts so
 *  the client bundle doesn't pull in that file's `server-only` import. */

/** Max length of the optional operator note posted as a Monday update.
 *  Generous — Monday updates handle long bodies fine; this is just a
 *  guardrail against an accidental paste of an entire page. */
export const MAX_OPERATOR_NOTE_LEN = 5000
