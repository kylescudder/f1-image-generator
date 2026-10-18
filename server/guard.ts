import { createClerkClient } from "@clerk/backend";
import { config } from "./config.ts";
import { errorResponse } from "./errors.ts";
import { services, type Services } from "./services.ts";

export type Identity = { userId: string | null; isAuthenticated: boolean };
export interface GuardOptions {
  // Tests replace Clerk with a fixed identity; production always uses Clerk.
  identity?: (request: Request) => Identity | Promise<Identity>;
  config?: Pick<
    typeof config,
    "clerkPublishableKey" | "clerkSecretKey" | "ownerId" | "appUrl"
  >;
}
export const guardOverrides: { current?: GuardOptions } = {};

// Identity comes only from Clerk's cryptographically verified session token.
export function ownerDecision(
  identity: { userId: string | null; isAuthenticated?: boolean },
  ownerId: string,
): 200 | 401 | 403 | 503 {
  if (!ownerId) return 503;
  if (!identity.isAuthenticated || !identity.userId) return 401;
  return identity.userId === ownerId ? 200 : 403;
}
const messages: Record<number, string> = {
  401: "Sign in to manage your library.",
  403: "This library is managed by its owner only.",
  503: "Owner access is not configured.",
};
async function clerkIdentity(
  request: Request,
  settings: NonNullable<GuardOptions["config"]>,
): Promise<Identity> {
  const state = await createClerkClient({
    publishableKey: settings.clerkPublishableKey,
    secretKey: settings.clerkSecretKey,
  }).authenticateRequest(request, {
    authorizedParties: [settings.appUrl],
    acceptsToken: "session_token",
  });
  // A handshake or signed-out state is never treated as an identity.
  if (!state.isAuthenticated) return { userId: null, isAuthenticated: false };
  return { userId: state.toAuth().userId, isAuthenticated: true };
}
async function ownerGate(request: Request): Promise<Response | null> {
  const options = guardOverrides.current;
  const settings = options?.config ?? config;
  const configured = Boolean(
    settings.clerkPublishableKey && settings.clerkSecretKey && settings.ownerId,
  );
  if (!configured && !options?.identity)
    return Response.json(
      {
        error:
          "Owner access is not configured. Set Clerk keys and CLERK_OWNER_USER_ID on Herman.",
      },
      { status: 503 },
    );
  const identity = options?.identity
    ? await options.identity(request)
    : await clerkIdentity(request, settings);
  const status = ownerDecision(identity, settings.ownerId);
  if (status !== 200)
    return Response.json({ error: messages[status] }, { status });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    request.headers.get("origin") !== settings.appUrl
  )
    return Response.json(
      { error: "This request must come from your own Paddock site." },
      { status: 403 },
    );
  return null;
}

// Wraps an owner-only handler: authenticate, authorise, then run it.
export function admin(
  handler: (
    request: Request,
    context: { params: Record<string, string>; services: Services },
  ) => Response | Promise<Response>,
) {
  return async ({
    request,
    params,
  }: {
    request: Request;
    params?: Record<string, string>;
  }) => {
    try {
      const denied = await ownerGate(request);
      const response =
        denied ??
        (await handler(request, {
          params: params ?? {},
          services: await services(),
        }));
      response.headers.set("Cache-Control", "no-store");
      return response;
    } catch (error) {
      return errorResponse(error);
    }
  };
}
