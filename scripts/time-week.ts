import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { Keypair, PublicKey, SystemProgram, Transaction, type AccountInfo } from "@solana/web3.js";
import {
  BASE_RPC, PROGRAM, TICK_MS, TRADING_TICKS, client, connection, decode, instruction, messageOf, pda, phaseOf,
  playerAddress, sendSigned, signSundayOpening, sleep, teeConnection, waitFor, weekAddresses,
  type Week, type WeekReceipt,
} from "../app/src/chain";

type SetupWeek = Week & { vrfRequested: boolean };
type Offer = { address: string; id: string; creator: string; transaction: string };
const seconds = (ms: number) => (ms / 1000).toFixed(2);

async function run() {
  const [relay, origin] = process.argv.slice(2);
  if (!relay || !origin) throw new Error("Usage: npx ts-node scripts/time-week.ts RELAY_ORIGIN UI_ORIGIN");
  const endpoint = new URL(relay).origin;
  const owner = Keypair.generate();
  const base = connection(BASE_RPC);
  const program = client(base, owner);
  const tee = teeConnection(owner);
  const t0 = performance.now();
  const points = new Map<string, number>();
  const controllers = new Set<AbortController>();

  async function post<T>(route: string, body: object): Promise<T> {
    const start = performance.now();
    const response = await fetch(`${endpoint}/api/week/${route}`, {
      method: "POST",
      headers: { Origin: new URL(origin).origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    console.log(`HTTP ${route} ${response.status} ${seconds(performance.now() - start)} s`);
    if (!response.ok) {
      const error = response.headers.get("Content-Type")?.includes("application/json")
        ? JSON.parse(text).error : `HTTP ${response.status}`;
      throw new Error(`${route}: ${error}`);
    }
    return JSON.parse(text) as T;
  }

  const mark = (name: string, time = performance.now()) => { if (!points.has(name)) points.set(name, time); };
  function observe(read: () => Promise<boolean>, interval: number) {
    const controller = new AbortController();
    controllers.add(controller);
    const task = (async () => {
      while (!controller.signal.aborted) {
        try {
          if (await read()) break;
        } catch (error) {
          // A transient observer failure must not resend sponsored transactions.
          if (!controller.signal.aborted && !/429|TimeoutError|fetch failed/i.test(messageOf(error))) {
            console.log(`Observer: ${messageOf(error).split("\n")[0]}`);
            break;
          }
        }
        if (!controller.signal.aborted) await sleep(interval);
      }
    })();
    return { stop: () => controller.abort(), task };
  }

  const point = (name: string, from: string, to: string) => {
    const a = points.get(from);
    const b = points.get(to);
    const value = a === undefined || b === undefined ? "not independently observed"
      : b <= a ? "same polling sample" : `${seconds(b - a)} s`;
    console.log(`${name}: ${value}`);
  };
  try {
    mark("prepare sent");
    const [offer, rpc] = await Promise.all([
      post<Offer>("prepare", { owner: owner.publicKey.toBase58(), fresh: true }).then((value) => {
        mark("prepare returned");
        return value;
      }),
      tee(),
    ]);
    const id = new BN(offer.id, 10);
    const { week, islands } = weekAddresses(id);
    assert.equal(week.toBase58(), offer.address);
    const creator = new PublicKey(offer.creator);
    const tx = Transaction.from(Buffer.from(offer.transaction, "base64"));
    const expected = new Transaction({ feePayer: creator, recentBlockhash: tx.recentBlockhash })
      .add(await instruction(program, "join", [id], {
        creator, owner: owner.publicKey, week, island: islands[0],
        player: playerAddress(week, owner.publicKey), systemProgram: SystemProgram.programId,
      }));
    assert.ok(tx.serializeMessage().equals(expected.serializeMessage()) && tx.verifySignatures(false));
    tx.partialSign(owner);

    function readWeek(info: AccountInfo<Buffer> | null) {
      return info && (info.owner.equals(PROGRAM) || info.owner.equals(DELEGATION_PROGRAM_ID))
        ? program.coder.accounts.decode<SetupWeek>("week", info.data) : null;
    }

    const acl = pda("permission:", [islands[0].toBuffer()], PERMISSION_PROGRAM_ID);
    mark("join sent");
    const baseObserver = observe(async () => {
      const info = await base.getAccountInfo(week);
      const state = readWeek(info);
      if (state?.players.every((player) => !player.equals(PublicKey.default))) mark("seats joined");
      if (info?.owner.equals(DELEGATION_PROGRAM_ID)) mark("base delegated");
      return points.has("base delegated");
    }, 500);
    const teeObserver = observe(async () => {
      // Before delegation the TEE can proxy the base-layer Week as program-owned.
      if (!points.has("base delegated")) return false;
      const [weekInfo, aclInfo] = await rpc.getMultipleAccountsInfo([week, acl]);
      if (weekInfo?.owner.equals(PROGRAM)) mark("TEE delegated");
      if (aclInfo?.owner.equals(PERMISSION_PROGRAM_ID)) mark("permissions ready");
      return points.has("permissions ready");
    }, 350);
    const receipt = await post<WeekReceipt>("join", {
      address: offer.address, transaction: tx.serialize().toString("base64"),
    });
    mark("join returned");
    // A successful join response guarantees permissions even if the permission PDA is filtered.
    mark("permissions ready");
    baseObserver.stop();
    teeObserver.stop();

    mark("start sent");
    let seededWeek: Week | undefined;
    const startObserver = observe(async () => {
      const state = decode<SetupWeek>(program, "week", await rpc.getAccountInfo(week));
      const sample = performance.now();
      if (state?.vrfRequested) mark("VRF requested", sample);
      if (state?.seeded) {
        seededWeek = state;
        mark("VRF callback", sample);
      }
      return points.has("VRF callback");
    }, 125);
    await post<WeekReceipt>("start", { address: receipt.address });
    mark("start returned");
    await Promise.race([startObserver.task, sleep(18_000)]);
    startObserver.stop();
    assert.ok(seededWeek, "The week did not receive its VRF callback");
    const readLive = async () => decode<Week>(program, "week", await rpc.getAccountInfo(week));
    const needsOpening = seededWeek.tickMs === TICK_MS && phaseOf(seededWeek) === "lobby";
    if (needsOpening) {
      mark("open Sunday sent");
      const offer = await post<{ transaction: string }>("open-sunday", { address: receipt.address });
      await sendSigned(rpc, await signSundayOpening(program, week, seededWeek, owner, offer.transaction), 250);
      await waitFor("Sunday opening", 10_000, async () => {
        const state = await readLive();
        return state && phaseOf(state) === "sunday" ? state : undefined;
      }, 400);
      mark("Sunday open");
      point("Open Sunday", "open Sunday sent", "Sunday open");
    }
    point("Prepare (HTTP)", "prepare sent", "prepare returned");
    point("Join all seats (observed)", "join sent", "seats joined");
    point("Delegate through TEE availability (observed)", "seats joined", "TEE delegated");
    point("Initialize permissions (observed)", "TEE delegated", "permissions ready");
    point("Start through VRF request (observed)", "start sent", "VRF requested");
    point("VRF callback after request (observed)", "VRF requested", "VRF callback");
    point("End to end through Sunday", "prepare sent", needsOpening ? "Sunday open" : "VRF callback");
    console.log(`Setup wall time including start response: ${seconds(performance.now() - t0)} s`);
    const deadline = Date.now() + TRADING_TICKS * seededWeek.tickMs + 60_000;
    while (Date.now() < deadline) {
      const state = await readLive();
      if (state && phaseOf(state) === "rotted") {
        await post<WeekReceipt>("settle", { address: receipt.address });
        return;
      }
      await sleep(2_000);
    }
    throw new Error("Timed out waiting for the timing week to rot.");
  } finally {
    for (const controller of controllers) controller.abort();
  }
}

void run().catch((error) => {
  console.error(messageOf(error).split("\n")[0]);
  process.exitCode = 1;
});
