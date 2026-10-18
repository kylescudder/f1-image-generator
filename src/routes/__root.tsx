import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { ClerkProvider } from "@clerk/tanstack-react-start";
import { getAppConfig } from "../lib/config";
import appCss from "../styles.css?url";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()(
  {
    beforeLoad: async () => ({ app: await getAppConfig() }),
    head: () => ({
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1.0" },
        { name: "theme-color", content: "#101111" },
        { title: "Paddock — Formula 1 artwork" },
        {
          name: "description",
          content:
            "A calendar-aware Formula 1 artwork library. Every season, every session, ready for your media library.",
        },
      ],
      links: [
        { rel: "stylesheet", href: appCss },
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      ],
    }),
    component: RootComponent,
    notFoundComponent: () => (
      <div className="fatal">
        <h1>This lap doesn’t exist.</h1>
        <p>
          <a href="/">Return to the collection</a>
        </p>
      </div>
    ),
  },
);

function RootComponent() {
  const { app, queryClient } = Route.useRouteContext();
  const content = (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {app.clerkPublishableKey ? (
          <ClerkProvider
            publishableKey={app.clerkPublishableKey}
            afterSignOutUrl="/"
          >
            {content}
          </ClerkProvider>
        ) : (
          content
        )}
        <Scripts />
      </body>
    </html>
  );
}
