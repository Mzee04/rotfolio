import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from "@solana/web3.js";
import { BASE_RPC, connection, messageOf, teeConnection, type SetupStep, type WeekReceipt } from "../src/chain";
import { createTurboWeek, loadDevnetPayer } from "./week";

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4096) throw new Error("Request is too large.");
  }
  return JSON.parse(body);
}

type Provision = Awaited<ReturnType<typeof createTurboWeek>>;
type Job = {
  owner: string;
  address?: string;
  prepare: Promise<Provision>;
  progress: { step: SetupStep };
  provision?: Promise<WeekReceipt>;
  start?: Promise<WeekReceipt>;
  settle?: Promise<WeekReceipt>;
  finished?: boolean;
  expiry?: ReturnType<typeof setTimeout>;
};

type WeekApiOptions = {
  payerPath: URL | string;
  allowedOrigin: (request: IncomingMessage) => string | undefined;
  weeksPerHour?: number;
  weeksPerIpHour?: number;
  minSol?: number;
  trustProxy?: boolean;
  log?: (line: string) => void;
};

const ROUTES = new Set(["prepare", "join", "start", "open-sunday", "settle", "status", "health"]);
const HOUR_MS = 60 * 60 * 1000;
const JOB_RETENTION_MS = 2 * HOUR_MS;

class AdmissionError extends Error {
  constructor(readonly status: 429 | 503, text: string) {
    super(text);
  }
}

export function createWeekApi({
  payerPath, allowedOrigin, weeksPerHour = 30, weeksPerIpHour = 4, minSol = 0.5, trustProxy = false, log,
}: WeekApiOptions) {
  const base = connection(BASE_RPC);
  const minLamports = Math.ceil(minSol * LAMPORTS_PER_SOL);
  let starts: { ip: string; startedAt?: number }[] = [];
  let jobNumber = 0;
  const jobs = new Map<string, Job>();
  const byWeek = new Map<string, Job>();
  let payerPromise: Promise<Keypair> | undefined;
  let getTee: ReturnType<typeof teeConnection> | undefined;

  function fundedPayer() {
    payerPromise ??= loadDevnetPayer(payerPath).catch((error) => {
      payerPromise = undefined;
      throw error;
    });
    return payerPromise;
  }

  function pruneStarts() {
    const cutoff = Date.now() - HOUR_MS;
    starts = starts.filter(({ startedAt }) => startedAt === undefined || startedAt > cutoff);
  }

  function clientIp(request: IncomingMessage) {
    if (trustProxy) {
      const header = request.headers["x-forwarded-for"];
      const first = (Array.isArray(header) ? header[0] : header)?.split(",", 1)[0]?.trim();
      if (first && isIP(first)) return first;
    }
    return request.socket.remoteAddress ?? "unknown";
  }

  function scheduleEviction(job: Job) {
    clearTimeout(job.expiry);
    job.expiry = setTimeout(() => {
      if (jobs.get(job.owner) === job) jobs.delete(job.owner);
      if (job.address && byWeek.get(job.address) === job) byWeek.delete(job.address);
    }, JOB_RETENTION_MS).unref();
  }

  function newJob(owner: PublicKey, key: string, ip: string) {
    pruneStarts();
    if (starts.length >= weeksPerHour) {
      throw new AdmissionError(429, "The demo has reached its hourly week limit. Please try again later.");
    }
    if (starts.filter((entry) => entry.ip === ip).length >= weeksPerIpHour) {
      throw new AdmissionError(429, "You have started too many weeks from this connection. Please try again later.");
    }
    // Reserve capacity before waiting on RPC. Overlapping requests must count toward both limits.
    const admission: (typeof starts)[number] = { ip };
    starts.push(admission);
    const id = ++jobNumber;
    const progress: Job["progress"] = { step: "prepare" };
    const prepare = (async () => {
      let payer: Keypair;
      try {
        payer = await fundedPayer();
        if (await base.getBalance(payer.publicKey) < minLamports) {
          log?.(`relay job=${id} prepare rejected reason=low-devnet-sol`);
          throw new AdmissionError(503, "The demo relay is out of devnet SOL. Please try again later.");
        }
      } catch (error) {
        starts = starts.filter((entry) => entry !== admission);
        throw error;
      }
      admission.startedAt = Date.now();
      getTee ??= teeConnection(payer);
      return createTurboWeek(owner, base, payer, getTee, {
        progress(step) { if (step !== "settle") progress.step = step; },
        finished(step, elapsed, ok) {
          log?.(`relay job=${id} step=${step} outcome=${ok ? "ok" : "error"} duration_ms=${Math.round(elapsed)}`);
        },
      });
    })();
    const job: Job = { owner: key, prepare, progress };
    jobs.set(key, job);
    void prepare.then(
      (week) => {
        job.address = week.receipt.address;
        byWeek.set(job.address, job);
      },
      () => { if (jobs.get(key) === job) jobs.delete(key); },
    );
    return job;
  }

  async function retryable<T>(job: Job, action: () => Promise<T>): Promise<T> {
    if (!job.finished) clearTimeout(job.expiry);
    try {
      const result = await action();
      if (!job.finished) clearTimeout(job.expiry);
      return result;
    } catch (error) {
      if (!job.finished) scheduleEviction(job);
      throw error;
    }
  }

  return async function handle(request: IncomingMessage, response: ServerResponse, next: () => void) {
    const route = request.url?.split("?")[0];
    if (!route?.startsWith("/api/week/")) return next();
    if (log) {
      const start = performance.now();
      const action = route.slice("/api/week/".length);
      const method = request.method === "POST" || request.method === "OPTIONS" ? request.method : "other";
      response.once("close", () => {
        const status = response.writableFinished ? response.statusCode : "aborted";
        log(`relay request=${method}:${ROUTES.has(action) ? action : "unknown"} status=${status} duration_ms=${Math.round(performance.now() - start)}`);
      });
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const respond = (status: number, data: unknown) => {
      response.statusCode = status;
      response.end(JSON.stringify(data));
    };

    const health = route === "/api/week/health";
    const origin = request.headers.origin;
    response.setHeader("Vary", "Origin");
    if (origin ? origin !== allowedOrigin(request) : !health) {
      return respond(403, { error: "Open the configured Rotfolio UI to play." });
    }

    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method !== "POST" || (!health && !request.headers["content-type"]?.startsWith("application/json"))) {
      return respond(405, { error: "Send a JSON POST request." });
    }

    try {
      if (health) {
        pruneStarts();
        return respond(200, { ok: true, weeksLeftThisHour: weeksPerHour - starts.length });
      }
      const payload = await bodyOf(request);
      if (route === "/api/week/status") {
        const job = byWeek.get(String(payload.address)) ?? jobs.get(String(payload.owner));
        return respond(200, { step: job?.progress.step ?? "prepare" });
      }
      if (route === "/api/week/prepare") {
        const owner = new PublicKey(String(payload.owner));
        if (!PublicKey.isOnCurve(owner.toBytes())) throw new Error("Invalid session public key.");
        const key = owner.toBase58();
        let job = jobs.get(key);
        if (payload.fresh === true && job?.settle && (await job.settle).final) {
          job = jobs.get(key) === job ? undefined : jobs.get(key);
        }
        job ??= newJob(owner, key, clientIp(request));
        const provision = await job.prepare;
        const creator = (await fundedPayer()).publicKey;
        return respond(200, {
          address: provision.receipt.address, creator: creator.toBase58(), id: provision.id.toString(),
          transaction: (await provision.joinOffer(!job.provision)).toString("base64"),
          ready: await job.provision,
        });
      }

      const job = byWeek.get(String(payload.address));
      if (!job) return respond(404, { error: "This week is unavailable in this server session." });
      const week = await job.prepare;

      if (route === "/api/week/join") {
        const signed = Transaction.from(Buffer.from(String(payload.transaction), "base64"));
        week.validateJoin(signed);
        job.provision ??= retryable(job, () => week.provision(signed))
          .catch((error) => { job.provision = undefined; throw error; });
        return respond(200, await job.provision);
      }

      if (!job.provision) throw new Error("Join your island before starting the week.");
      await job.provision;
      if (route === "/api/week/start") {
        job.start ??= retryable(job, () => week.start())
          .catch((error) => { job.start = undefined; throw error; });
        return respond(200, await job.start);
      }

      if (route === "/api/week/open-sunday") {
        if (!job.start) throw new Error("Prepare the week's prices before opening Sunday.");
        await job.start;
        return respond(200, { transaction: await retryable(job, week.sundayOffer) });
      }

      if (route === "/api/week/settle") {
        job.settle ??= retryable(job, week.settle).then((receipt) => {
          job.finished = true;
          scheduleEviction(job);
          return receipt;
        }).catch((error) => { job.settle = undefined; throw error; });
        return respond(200, await job.settle);
      }

      respond(404, { error: "Unknown week operation." });
    } catch (error) {
      respond(error instanceof AdmissionError ? error.status : 400, { error: messageOf(error) });
    }
  };
}
