import { createServer } from "node:http";
import { resolve } from "node:path";
import { createWeekApi } from "../app/server/week-api";

function uiOrigin() {
  const value = process.env.ROTFOLIO_UI_ORIGIN;
  if (value) {
    try {
      const url = new URL(value);
      const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
      if ((url.protocol === "https:" || loopback) && value.replace(/\/$/, "") === url.origin) return url.origin;
    } catch { /* Report the setting name without logging its value. */ }
  }
  throw new Error("Set ROTFOLIO_UI_ORIGIN to the UI's HTTPS origin or a loopback test origin.");
}

function positiveInteger(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Set ${name} to an integer from 1 to ${maximum}.`);
  }
  return value;
}

function minimumSol() {
  const setting = process.env.ROTFOLIO_RELAY_MIN_SOL ?? "0.5";
  const value = Number(setting);
  if (!setting.trim() || !Number.isFinite(value) || value < 0) {
    throw new Error("Set ROTFOLIO_RELAY_MIN_SOL to a nonnegative amount of devnet SOL.");
  }
  return value;
}

try {
  const origin = uiOrigin();
  const port = positiveInteger("ROTFOLIO_RELAY_PORT", 8787, 65535);
  const payerPath = process.env.ROTFOLIO_DEVNET_PAYER_PATH;
  if (payerPath === undefined) {
    console.warn("Relay is using keys/deployer.json, the program upgrade authority. A dedicated devnet payer is recommended.");
  }
  const handle = createWeekApi({
    payerPath: payerPath ?? resolve(__dirname, "../keys/deployer.json"),
    allowedOrigin: () => origin,
    weeksPerHour: positiveInteger("ROTFOLIO_RELAY_WEEKS_PER_HOUR", 30),
    weeksPerIpHour: positiveInteger("ROTFOLIO_RELAY_WEEKS_PER_IP_HOUR", 4),
    minSol: minimumSol(),
    trustProxy: process.env.ROTFOLIO_TRUST_PROXY === "1",
    log: (line) => console.log(line),
  });
  const server = createServer((request, response) => {
    void handle(request, response, () => {
      response.statusCode = 404;
      response.end("Not found");
    });
  });
  server.on("error", (error) => {
    console.error(`Could not start the devnet relay (${(error as NodeJS.ErrnoException).code ?? "server error"}).`);
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => console.log(`Devnet week relay listening on http://127.0.0.1:${port}`));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Could not start the devnet relay.");
  process.exitCode = 1;
}
