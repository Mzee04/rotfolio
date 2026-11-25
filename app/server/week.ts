import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as anchor from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram, Transaction, type TransactionInstruction,
} from "@solana/web3.js";
import {
  PROGRAM, TICK_MS, client, decode, instruction, marketMetas, messageOf, pda, phaseOf,
  playerAddress, rollup, sendSigned, sundayInstruction, waitFor, weekAddresses,
  type Island, type SetupStep, type Week, type WeekReceipt,
} from "../src/chain";

// Vite loads Anchor through Node ESM, while the CLI uses CommonJS.
const { BN } = (anchor as typeof anchor & { default?: typeof anchor }).default ?? anchor;
const oracleQueue = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const vrfProgram = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const metas = (keys: PublicKey[], isWritable = true) =>
  keys.map((pubkey) => ({ pubkey, isWritable, isSigner: false }));

function delegation(kind: "Island" | "Player" | "Week", account: PublicKey) {
  const seeds = [account.toBuffer()];
  return {
    [`buffer${kind}`]: pda("buffer", seeds),
    [`delegationRecord${kind}`]: pda("delegation", seeds, DELEGATION_PROGRAM_ID),
    [`delegationMetadata${kind}`]: pda("delegation-metadata", seeds, DELEGATION_PROGRAM_ID),
    ownerProgram: PROGRAM,
    delegationProgram: DELEGATION_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

export async function loadDevnetPayer(path: URL | string) {
  try {
    const data = await readFile(path, "utf8");
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(data)));
  } catch {
    throw new Error("The local devnet payer is unavailable. Check keys/deployer.json.");
  }
}

type Step = SetupStep | "settle";
type Trace = { progress: (step: Step) => void; finished: (step: Step, elapsed: number, ok: boolean) => void };
const SETUP_POLL = 250;

export async function sendTransaction(
  rpc: Connection, payer: Keypair, instructions: TransactionInstruction[],
  { units, cosigners = [], interval = 500, blockhash }: {
    units?: number; cosigners?: Keypair[]; interval?: number; blockhash?: string;
  } = {},
) {
  const recentBlockhash = blockhash ?? (await rpc.getLatestBlockhash("confirmed")).blockhash;
  const transaction = new Transaction({ feePayer: payer.publicKey, recentBlockhash });
  if (units) transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units }));
  transaction.add(...instructions);
  transaction.sign(payer, ...cosigners);
  return sendSigned(rpc, transaction, interval);
}

export async function createTurboWeek(
  owner: PublicKey, base: Connection, payer: Keypair, tee: () => Promise<Connection>, trace?: Trace,
) {
  async function measure<T>(step: Step, action: () => Promise<T>) {
    trace?.progress(step);
    const start = performance.now();
    let ok = false;
    try {
      const value = await action();
      ok = true;
      return value;
    } finally {
      trace?.finished(step, performance.now() - start, ok);
    }
  }

  const program = client(base, payer);
  const id = new BN(randomBytes(8), "le");
  const { week, islands } = weekAddresses(id);
  const creator = payer.publicKey;
  const bots = Array.from({ length: 3 }, () => Keypair.generate());
  const owners = [owner, ...bots.map((bot) => bot.publicKey)];
  const players = owners.map((key) => playerAddress(week, key));
  const participants = [...islands, ...players];
  const fullWeek = marketMetas(islands, players, owner);
  const join = (index: number) => instruction(program, "join", [id], {
    creator, owner: owners[index], week, island: islands[index], player: players[index],
    systemProgram: SystemProgram.programId,
  });

  async function issueJoinOffer() {
    const { blockhash: recentBlockhash } = await base.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: creator, recentBlockhash }).add(await join(0));
    transaction.partialSign(payer);
    return { transaction, issuedAt: Date.now() };
  }

  const steps = new Map<string, string>();
  const receipt: WeekReceipt = { address: week.toBase58(), delegation: "" };
  let offer = await measure("prepare", async () => {
    await sendTransaction(base, payer, [await instruction(program, "createWeek", [id, TICK_MS], {
      creator, week, island0: islands[0], island1: islands[1], island2: islands[2], island3: islands[3],
      systemProgram: SystemProgram.programId,
    })], { units: 550_000, interval: SETUP_POLL });
    return issueJoinOffer();
  });

  async function checkpoint(name: string, action: () => Promise<string>) {
    const prior = steps.get(name);
    if (prior) return prior;
    const signature = await action();
    steps.set(name, signature);
    return signature;
  }

  async function joinOffer(refresh = false) {
    if (refresh && !steps.has("human") && Date.now() - offer.issuedAt > 50_000) {
      offer = await issueJoinOffer();
    }
    return offer.transaction.serialize({ requireAllSignatures: false });
  }

  function validateJoin(signed: Transaction) {
    if (!signed.serializeMessage().equals(offer.transaction.serializeMessage()) || !signed.verifySignatures()) {
      throw new Error("The join signature did not match this week.");
    }
  }

  async function provision(signed: Transaction) {
    await measure("join", async () => {
      await checkpoint("human", () => sendSigned(base, signed, SETUP_POLL));
      // Each join takes the next seat, so execute bot joins in order in one transaction.
      await checkpoint("bots", async () => sendTransaction(
        base, payer, await Promise.all(bots.map((_, index) => join(index + 1))),
        { units: 500_000, cosigners: bots, interval: SETUP_POLL },
      ));
    });

    const rpc = await measure("delegate", async () => {
      const [teeRpc, result] = await Promise.allSettled([
        tee(),
        (async () => {
          const { blockhash } = await base.getLatestBlockhash("confirmed");
          const results = await Promise.allSettled(owners.map((seat, index) =>
            checkpoint(`delegate seat ${index}`, async () => sendTransaction(base, payer, [
              await instruction(program, "delegateIsland", [id, index], {
                creator, week, island: islands[index], ...delegation("Island", islands[index]),
              }),
              await instruction(program, "delegatePlayer", [id, seat], {
                creator, week, player: players[index], ...delegation("Player", players[index]),
              }),
            ], { units: 650_000, interval: SETUP_POLL, blockhash }))));
          // Wait for all in-flight sends before allowing a retry of an unfinished leg.
          const failed = results.find((item) => item.status === "rejected");
          if (failed) throw failed.reason;
          receipt.delegation = await checkpoint("delegate week", async () =>
            sendTransaction(base, payer, [await instruction(program, "delegateWeek", [id], {
              creator, week, ...delegation("Week", week),
            }, metas(participants, false))], { units: 500_000, interval: SETUP_POLL }));
        })(),
      ]);
      if (result.status === "rejected") throw result.reason;
      if (teeRpc.status === "rejected") throw teeRpc.reason;
      await waitFor("TEE delegation", 55_000, async () => {
        const infos = await teeRpc.value.getMultipleAccountsInfo([week, ...participants]);
        return infos.every((info) => info?.owner.equals(PROGRAM)) ? true : undefined;
      }, 350);
      return teeRpc.value;
    });

    await measure("permissions", async () => sendTransaction(rpc, payer, [await instruction(program, "initPermissions", [], {
      creator, week, rollup,
    }, fullWeek)], { units: 750_000, interval: SETUP_POLL }));
    return receipt;
  }

  async function start() {
    const rpc = await tee();
    const startIx = await instruction(program, "startWeek", [], {
      creator, week, rollup, oracleQueue, programIdentity: pda("identity", []),
      vrfProgram, slotHashes: SYSVAR_SLOT_HASHES_PUBKEY, systemProgram: SystemProgram.programId,
    }, fullWeek);
    const sendStart = () => sendTransaction(rpc, payer, [startIx], { interval: SETUP_POLL });
    const readWeek = async () => decode<Week & { vrfRequested: boolean }>(program, "week", await rpc.getAccountInfo(week));
    if (!receipt.vrf) {
      try {
        receipt.vrf = await measure("start", sendStart);
      } catch (error) {
        // A lost response can leave the request on-chain even when confirmation failed here.
        if (!(await readWeek())?.vrfRequested) throw error;
      }
    }
    const waitForSeed = () => waitFor("VRF seed", 21_000, async () =>
      (await readWeek())?.seeded ? true : undefined, SETUP_POLL);
    await measure("vrf", async () => {
      try {
        await waitForSeed();
      } catch (error) {
        if (messageOf(error) !== "Timed out waiting for VRF seed.") throw error;
        if (!(await readWeek())?.seeded) {
          receipt.vrf = await sendStart();
          await waitForSeed();
        }
      }
    });
    return receipt;
  }

  async function settle() {
    const rpc = await tee();
    if (!receipt.settle) {
      const state = decode<Week>(program, "week", await rpc.getAccountInfo(week));
      if (!state || phaseOf(state) !== "rotted") throw new Error("The market has not reached rot.");
      receipt.settle = await sendTransaction(rpc, payer, [await instruction(program, "settle", [], {
        week, payer: creator, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
      }, metas(participants))], { units: 800_000 });
    }
    receipt.final = await waitFor("devnet undelegation", 65_000, async () => {
      const [weekInfo, ...infos] = await base.getMultipleAccountsInfo([week, ...participants]);
      if (!infos.every((info) => info?.owner.equals(PROGRAM))) return;
      const state = decode<Week>(program, "week", weekInfo);
      if (!state || phaseOf(state) !== "settled") return;
      const tracks = infos.slice(0, 4).map((info) => decode<Island>(program, "island", info));
      if (tracks.some((track) => !track)) return;
      return { islands: tracks as Island[], scores: state.scoreboard.map(({ coins }) => coins.toNumber()) };
    }, 1_000);
    return receipt;
  }

  async function sundayOffer() {
    const rpc = await tee();
    const { blockhash: recentBlockhash } = await rpc.getLatestBlockhash("confirmed");
    const transaction = new Transaction({ feePayer: creator, recentBlockhash }).add(
      await sundayInstruction(program, "openSunday", week, { creator, islands, players }, owner),
    );
    transaction.partialSign(payer);
    return transaction.serialize({ requireAllSignatures: false }).toString("base64");
  }

  return {
    id, week, islands, players, receipt, joinOffer, validateJoin, provision, start, sundayOffer,
    settle: () => measure("settle", settle),
  };
}
