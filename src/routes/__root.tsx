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
            appearance={{
              variables: {
                colorPrimary: "#f45540",
                colorPrimaryForeground: "#101111",
                colorBackground: "#171a18",
                colorForeground: "#edece7",
                colorMutedForeground: "#a8b0a5",
                colorNeutral: "#edece7",
                colorInput: "#101111",
                colorInputForeground: "#edece7",
                colorBorder: "#292d2a",
                colorRing: "#f45540",
                colorDanger: "#ff8b7c",
                colorSuccess: "#a8bca4",
                fontFamily: '"DM Sans", sans-serif',
                fontFamilyButtons: '"DM Sans", sans-serif',
                borderRadius: "0.5rem",
              },
              elements: {
                cardBox: {
                  border: "1px solid #292d2a",
                  boxShadow: "none",
                },
                card: { boxShadow: "none" },
                headerTitle: {
                  fontFamily: '"Space Grotesk", sans-serif',
                  fontSize: "1.375rem",
                  fontWeight: 500,
                  letterSpacing: "-0.5px",
                },
                formButtonPrimary: {
                  backgroundImage: "none",
                  boxShadow: "none",
                  minHeight: "40px",
                },
                formFieldInput: { minHeight: "40px" },
                footer: { background: "#131614" },
              },
            }}
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
