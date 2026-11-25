import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { turboWeekServer } from "./server/turbo";

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  define: { global: "globalThis" },
  server: {
    host: "127.0.0.1",
    strictPort: true,
    fs: {
      allow: [path("."), path("../node_modules")],
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/keys/**", "**/app/server/**"],
    },
  },
  plugins: [turboWeekServer()],
});
