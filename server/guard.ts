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
    "clerkPublishableKey" | "clerkSecretKey" | "appUrl"
  >;
}
export const guardOverrides: { current?: GuardOptions } = {};

// Identity comes only from Clerk's cryptographically verified session token.
// Clerk is invite-only, so any signed-in user is trusted to administer.
export function accessDecision(identity: {
  userId: string | null;
  isAuthenticated?: boolean;
}): 200 | 401 {
  return identity.isAuthenticated && identity.userId ? 200 : 401;
}
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
    settings.clerkPublishableKey && settings.clerkSecretKey,
  );
  if (!configured && !options?.identity)
    return Response.json(
      {
        error: "Sign-in is not configured. Set the Clerk keys on the host.",
      },
      { status: 503 },
    );
  const identity = options?.identity
    ? await options.identity(request)
    : await clerkIdentity(request, settings);
  if (accessDecision(identity) !== 200)
    return Response.json(
      { error: "Sign in to manage your library." },
      { status: 401 },
    );
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

// Wraps a signed-in-only handler: authenticate, then run it.
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
