import path from "node:path";

export const config = {
  port: Number(process.env.PORT || 3000),
  appUrl: new URL(process.env.APP_URL || "http://localhost:3000").origin,
  dataDir: path.resolve(process.env.DATA_DIR || "./data"),
  root: process.cwd(),
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY || "",
  openrouterKey: process.env.OPENROUTER_API_KEY || "",
  embyUrl: (process.env.EMBY_URL || "").replace(/\/$/, ""),
  embyKey: process.env.EMBY_API_KEY || "",
};
export const authConfigured = Boolean(
  config.clerkPublishableKey && config.clerkSecretKey,
);
