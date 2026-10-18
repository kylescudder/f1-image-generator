import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";

// Server code runs on Bun (Bun.SQL for PostgreSQL), and sharp/fontkit are native or heavy.
const serverOnly = ["bun", "sharp", "fontkit"];

export default defineConfig({
  server: { port: 3000, allowedHosts: true },
  ssr: { external: serverOnly },
  environments: {
    ssr: { build: { rolldownOptions: { external: serverOnly } } },
  },
  // tanstackStart must come before the React plugin.
  plugins: [tanstackStart(), viteReact()],
});
