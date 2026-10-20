import { createServerFn } from "@tanstack/react-start";

// Clerk keys are runtime environment on the host, so they are read per request
// rather than baked into the client bundle at build time.
export const getAppConfig = createServerFn({ method: "GET" }).handler(
  async () => {
    const { authConfigured } = await import("../../server/config.ts");
    return {
      clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
      authConfigured,
    };
  },
);
