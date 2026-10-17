import React from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/react";
import { App } from "./App.tsx";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
fetch("/api/config")
  .then((response) => response.json())
  .then((config: { clerkPublishableKey: string; authConfigured: boolean }) => {
    const app = (
      <App
        authConfigured={config.authConfigured}
        hasClerk={Boolean(config.clerkPublishableKey)}
      />
    );
    root.render(
      config.clerkPublishableKey ? (
        <ClerkProvider
          publishableKey={config.clerkPublishableKey}
          afterSignOutUrl="/"
        >
          {app}
        </ClerkProvider>
      ) : (
        app
      ),
    );
  })
  .catch(() =>
    root.render(
      <div className="fatal">
        <h1>Paddock is taking a pit stop.</h1>
        <p>The server could not be reached. Refresh to try again.</p>
      </div>,
    ),
  );
