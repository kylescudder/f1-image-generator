import { z } from "zod";
import { config } from "./config.ts";

// A problem with what was asked for, rather than a failure while doing it.
export class RequestError extends Error {}
export function safeError(error: unknown, secrets: string[]) {
  let message =
    error instanceof Error ? error.message : "Something went wrong. Try again.";
  for (const secret of secrets)
    if (secret) message = message.replaceAll(secret, "[redacted]");
  return message.slice(0, 1000);
}
export const redactSecrets = (error: unknown) =>
  safeError(error, [
    config.openrouterKey,
    config.embyKey,
    config.clerkSecretKey,
  ]);
export function errorResponse(error: unknown) {
  const message =
    error instanceof z.ZodError
      ? "Some fields are invalid. Check your settings and try again."
      : redactSecrets(error);
  const status =
    error instanceof z.ZodError || error instanceof RequestError
      ? 400
      : /already queued|duplicate key|already.*running/.test(message)
        ? 409
        : /limit reached/.test(message)
          ? 429
          : 500;
  return Response.json({ error: message }, { status });
}
