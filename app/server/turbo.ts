import type { Plugin } from "vite";
import { createWeekApi } from "./week-api";

export function turboWeekServer(): Plugin {
  return {
    name: "rotfolio-devnet-week",
    configureServer(server) {
      server.middlewares.use(createWeekApi({
        payerPath: new URL("../../keys/deployer.json", import.meta.url),
        allowedOrigin(request) {
          const host = request.headers.host;
          return /^127\.0\.0\.1:\d+$/.test(host ?? "") ? `http://${host}` : undefined;
        },
      }));
    },
  };
}
