// HTTP status and message for a caught error. A ZodError has no status and its message is a
// JSON dump of issues; it is bad input, so 400 with a short message.
import { z } from 'zod';

export const errStatus = (e: unknown): number =>
  e instanceof z.ZodError ? 400 : ((e as { status?: number }).status ?? 500);

export const errMessage = (e: unknown): string =>
  e instanceof z.ZodError
    ? `invalid input: ${e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')}`
    : errStatus(e) === 500
      ? internal(e)
      : (e as Error).message;

// Unexpected errors: the detail (e.g. SQL text) goes to the log, never to the client.
function internal(e: unknown): string {
  console.error('internal error:', (e as Error)?.message ?? e);
  return 'internal error';
}
