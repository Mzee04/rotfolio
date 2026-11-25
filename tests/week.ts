import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as pause } from "node:timers/promises";
import { AnchorProvider, BN, Idl, Program, utils } from "@coral-xyz/anchor";
import {
  DELEGATION_PROGRAM_ID,
  EPHEMERAL_VAULT_ID,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  getAuthToken,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  AccountInfo,
  AccountMeta,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_SLOT_HASHES_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";

const BASE_RPC = "https://api.devnet.solana.com";
const TEE_RPC = "https://devnet-tee.magicblock.app";
const PROGRAM_ID = new PublicKey("9czd3zpazBa4fLBcNihWyKEgeKkZ4K8xEdoMWeY5Zj9b");
const VRF_PROGRAM = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const VRF_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
const TICK_MS = 10_000;
const SUNDAY_BUY_SECONDS = 30;
const START_COINS = 12_000;
const STAKE = 100;

const rollup = {
  permissionProgram: PERMISSION_PROGRAM_ID,
  ephemeralVault: EPHEMERAL_VAULT_ID,
  magicProgram: MAGIC_PROGRAM_ID,
};

type Phase = "lobby" | "sunday" | "trading" | "rotted" | "settled";
type Score = { owner: PublicKey; coins: BN };
type Week = {
  phase: Partial<Record<Phase, object>>;
  tick: number;
  tickMs: number;
  startTs: BN;
  sundayEndTs: BN;
  nextTickTs: BN;
  gatesOpen: number[];
  crankTaskId: BN;
  seeded: boolean;
  scoreboard: Score[];
};
type Island = { pattern: number; sundayPrice: number; prices: number[] };
type Player = { owner: PublicKey; coins: BN; rots: number; bought: boolean; passesUsed: number };
type Accounts = Record<string, PublicKey | Record<string, PublicKey>>;

function pda(seed: string, seeds: Buffer[], programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...seeds], programId)[0];
}

function metas(addresses: readonly PublicKey[], isWritable = true): AccountMeta[] {
  return addresses.map((pubkey) => ({ pubkey, isWritable, isSigner: false }));
}

function permission(address: PublicKey): PublicKey {
  return pda("permission:", [address.toBuffer()], PERMISSION_PROGRAM_ID);
}

function delegation(kind: "Island" | "Player" | "Week", account: PublicKey): Record<string, PublicKey> {
  const key = account.toBuffer();
  return {
    [`buffer${kind}`]: pda("buffer", [key]),
    [`delegationRecord${kind}`]: pda("delegation", [key], DELEGATION_PROGRAM_ID),
    [`delegationMetadata${kind}`]: pda("delegation-metadata", [key], DELEGATION_PROGRAM_ID),
    ownerProgram: PROGRAM_ID,
    delegationProgram: DELEGATION_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

const retryRpc: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(input, { ...init, signal: AbortSignal.timeout(8_000) });
    } catch (error) {
      if (attempt >= 4) throw error;
      await pause(150 * (attempt + 1));
      continue;
    }
    if (attempt >= 4 || (response.status !== 429 && response.status < 500)) return response;
    const retryAfter = Number(response.headers.get("Retry-After")) || 0;
    await response.body?.cancel();
    await pause(Math.min(8_000, Math.max(350 * 2 ** attempt, retryAfter * 1_000)));
  }
};

function rpcConnection(endpoint: string): Connection {
  return new Connection(endpoint, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: retryRpc,
  });
}

async function tee(session: Keypair): Promise<Connection> {
  const { token } = await getAuthToken(
    TEE_RPC,
    session.publicKey,
    async (message) => nacl.sign.detached(message, session.secretKey),
  );
  return rpcConnection(`${TEE_RPC}?token=${encodeURIComponent(token)}`);
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  read: () => Promise<T | undefined>,
  pollMs = 400,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch (error) {
      if (!(error instanceof Error) || !/fetch failed|TimeoutError|429 Too Many Requests/i.test(error.message)) {
        throw error;
      }
    }
    await pause(pollMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function phase(week: Week, expected: Phase): boolean {
  return Object.hasOwn(week.phase, expected);
}

describe("Rotfolio devnet TEE week", () => {
  it("runs a private market week from delegation through undelegation", async () => {
    try {
      await runWeek();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replace(/([?&]token=)[^&\s"']+/gi, "$1[redacted]"));
    }
  });
});

async function runWeek(): Promise<void> {
  const idl: Idl = JSON.parse(readFileSync("target/idl/rotfolio.json", "utf8"));
  assert.equal(idl.address, PROGRAM_ID.toBase58(), "IDL must match the devnet program");
  const deployer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync("keys/deployer.json", "utf8"))),
  );
  const seats = Array.from({ length: 4 }, () => Keypair.generate());
  const human = seats[0];
  const outsider = Keypair.generate();
  const base = rpcConnection(BASE_RPC);
  const provider = new AnchorProvider(base, {
    publicKey: deployer.publicKey,
    async signTransaction(tx) { return tx; },
    async signAllTransactions(txs) { return txs; },
  }, AnchorProvider.defaultOptions());
  const program = new Program(idl, provider);
  const weekId = randomBytes(8);
  const id = new BN(weekId, "le");
  const weekKey = pda("week", [weekId]);
  const islands = seats.map((_, index) => pda("island", [weekKey.toBuffer(), Buffer.from([index])]));
  const players = seats.map(({ publicKey }) => pda("player", [weekKey.toBuffer(), publicKey.toBuffer()]));
  const gates = islands.map((island) => pda("gate", [island.toBuffer(), human.publicKey.toBuffer()]));
  const participants = [...islands, ...players];
  const fullWeek = metas([
    ...participants,
    ...islands.map(permission),
    ...players.map(permission),
    ...gates.slice(1),
    ...gates.slice(1).map(permission),
  ]);
  const creator = deployer.publicKey;

  const ix = (name: string, args: unknown[], accounts: Accounts, extra: AccountMeta[] = []) =>
    program.methods[name](...args).accountsStrict(accounts).remainingAccounts(extra).instruction();

  async function send(
    label: string,
    connection: Connection,
    instructions: TransactionInstruction[],
    signers: Keypair[],
    options: { units?: number; error?: string; blockhash?: string } = {},
  ): Promise<string> {
    let signature: string;
    try {
      const blockhash = options.blockhash ?? (await connection.getLatestBlockhash("confirmed")).blockhash;
      const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: blockhash });
      if (options.units) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: options.units }));
      tx.add(...instructions);
      tx.sign(...signers);
      assert.ok(tx.signature, `Missing ${label} signature`);
      signature = utils.bytes.bs58.encode(tx.signature);
      try {
        const accepted = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: options.error !== undefined,
          preflightCommitment: "confirmed",
          maxRetries: 2,
        });
        assert.equal(accepted, signature, `Unexpected signature for ${label}`);
      } catch (error) {
        // A retried send may have landed before the first HTTP response was lost.
        if (!(error instanceof Error) || !/already been processed/i.test(error.message)) throw error;
      }
    } catch (error) {
      throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const status = await waitFor(`${label} confirmation`, 23_000, async () => {
      const { value } = await connection.getSignatureStatuses([signature]);
      const landed = value[0];
      if (landed?.confirmationStatus === "confirmed" || landed?.confirmationStatus === "finalized") {
        return landed;
      }
      return undefined;
    }, connection === base ? 1_000 : 600);
    if (options.error) {
      const expected = program.idl.errors?.find(
        ({ name }) => name.toLowerCase() === options.error!.toLowerCase(),
      );
      assert.ok(expected, `Missing IDL error ${options.error}`);
      assert.deepEqual(status.err, { InstructionError: [0, { Custom: expected.code }] }, label);
    } else {
      assert.equal(status.err, null, `${label} failed: ${JSON.stringify(status.err)}`);
    }
    return signature;
  }

  function decode<T>(kind: string, info: AccountInfo<Buffer> | null): T {
    assert.ok(info, `Expected readable ${kind}`);
    assert.ok(info.owner.equals(PROGRAM_ID), `Unexpected ${kind} program owner`);
    return program.coder.accounts.decode<T>(kind, info.data);
  }

  const [creatorTee, aTee, outsiderTee, ownerOneTee] = await Promise.all([
    tee(deployer), tee(human), tee(outsider), tee(seats[1]),
  ]);
  const readWeek = async () => decode<Week>("week", await aTee.getAccountInfo(weekKey));
  const readPlayer = async () => decode<Player>("player", await aTee.getAccountInfo(players[0]));
  const waitWeek = (label: string, accept: (week: Week) => boolean, timeout = 28_000) =>
    waitFor(label, timeout, async () => {
      const week = await readWeek();
      return accept(week) ? week : undefined;
    }, 1_000);
  const buy = (qty: number) => ix("buy", [qty], {
    week: weekKey, signer: human.publicKey, player: players[0], island: islands[0],
  });
  const requestGate = (index: number) => ix("requestGate", [index], {
    week: weekKey, signer: human.publicKey, player: players[0], island: islands[index],
  });
  const manageGate = (name: "openGate" | "closeGate", index: number) => ix(name, [human.publicKey], {
    week: weekKey,
    owner: seats[index].publicKey,
    island: islands[index],
    ownerPlayer: players[index],
    visitorPlayer: players[0],
    islandPermission: permission(islands[index]),
    gatePass: gates[index],
    gatePermission: permission(gates[index]),
    rollup,
  });
  const sell = (index: number, qty: number) => ix("sell", [index, qty], {
    week: weekKey, signer: human.publicKey, player: players[0], island: islands[index], gatePass: gates[index],
  });

  console.log(`Creating devnet week ${weekKey.toBase58()}`);
  await send("create week", base, [await ix("createWeek", [id, TICK_MS], {
    creator, week: weekKey, island0: islands[0], island1: islands[1],
    island2: islands[2], island3: islands[3], systemProgram: SystemProgram.programId,
  })], [deployer], { units: 550_000 });
  for (const [index, owner] of seats.entries()) {
    await send(`join island ${index}`, base, [await ix("join", [id], {
      creator, owner: owner.publicKey, week: weekKey, island: islands[index],
      player: players[index], systemProgram: SystemProgram.programId,
    })], [deployer, owner]);
  }
  assert.equal(await base.getBalance(human.publicKey), 0, "The relay must pay for the human session");

  let delegationSignature = "";
  for (const [index, owner] of seats.entries()) {
    delegationSignature = await send(`delegate island and player ${index}`, base, [
      await ix("delegateIsland", [id, index], {
        creator, week: weekKey, island: islands[index], ...delegation("Island", islands[index]),
      }),
      await ix("delegatePlayer", [id, owner.publicKey], {
        creator, week: weekKey, player: players[index], ...delegation("Player", players[index]),
      }),
    ], [deployer], { units: 650_000 });
  }
  await send("delegate week", base, [await ix("delegateWeek", [id], {
    creator, week: weekKey, ...delegation("Week", weekKey),
  }, metas(participants, false))], [deployer], { units: 500_000 });

  await waitFor("all nine accounts on the TEE", 55_000, async () => {
    const infos = await creatorTee.getMultipleAccountsInfo([weekKey, ...participants]);
    return infos.every((info) => info?.owner.equals(PROGRAM_ID)) ? true : undefined;
  }, 1_000);
  await send("initialize private permissions", creatorTee, [await ix("initPermissions", [], {
    creator, week: weekKey, rollup,
  }, fullWeek)], [deployer], { units: 750_000 });
  assert.equal(await outsiderTee.getAccountInfo(islands[0]), null, "Island 0 must be private before VRF");
  assert.equal(await outsiderTee.getAccountInfo(players[0]), null, "Player A must be private before VRF");

  const start = await ix("startWeek", [], {
    creator,
    week: weekKey,
    rollup,
    oracleQueue: VRF_QUEUE,
    programIdentity: pda("identity", []),
    vrfProgram: VRF_PROGRAM,
    slotHashes: SYSVAR_SLOT_HASHES_PUBKEY,
    systemProgram: SystemProgram.programId,
  }, fullWeek);
  const [oversizedBuy, fullBuy, openSunday] = await Promise.all([
    buy(101), buy(STAKE),
    ix("openSunday", [], { creator, signer: human.publicKey, week: weekKey, rollup }, fullWeek),
  ]);
  let vrfSignature = await send("start week and request VRF", creatorTee, [start], [deployer]);
  let seeded: Week;
  try {
    seeded = await waitWeek("VRF callback", (week) => week.seeded, 21_000);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Timed out waiting for VRF callback") throw error;
    const beforeRetry = await readWeek();
    if (beforeRetry.seeded) {
      seeded = beforeRetry;
    } else {
      vrfSignature = await send("retry VRF", creatorTee, [start], [deployer]);
      seeded = await waitWeek("retried VRF callback", (week) => week.seeded, 22_000);
    }
  }
  assert.ok(phase(seeded, "lobby"), "VRF must leave the buy clock idle");
  assert.ok(seeded.sundayEndTs.isZero(), "VRF must not set the buy deadline");
  assert.ok(seeded.crankTaskId.isZero(), "The crank starts with the buy card");
  await send("reject buy before the buy card", aTee, [fullBuy], [human], { error: "WrongPhase" });

  const buyCardVisibleAt = performance.now();
  await send("open Sunday after the buy card appears", aTee, [openSunday], [deployer, human]);
  const sunday = await waitWeek("player opens Sunday", (state) => phase(state, "sunday"));
  assert.ok(!sunday.crankTaskId.isZero(), "Opening Sunday must schedule the crank");
  assert.equal(sunday.sundayEndTs.sub(sunday.startTs).toNumber(), SUNDAY_BUY_SECONDS);
  assert.ok(sunday.scoreboard.every(({ coins }) => coins.isZero()), "Scores must stay hidden until rot");
  const sundayBlockhash = (await aTee.getLatestBlockhash()).blockhash;
  await send("replay Sunday opening", aTee, [openSunday], [deployer, human], { blockhash: sundayBlockhash });
  assert.ok((await readWeek()).sundayEndTs.eq(sunday.sundayEndTs), "Replay must preserve the deadline");
  console.log(`VRF request ${vrfSignature} and delegation ${delegationSignature}`);

  await send("reject 101-Rot buy", aTee, [oversizedBuy], [human], { error: "BuyCap", blockhash: sundayBlockhash });
  await send("buy 100 Rots", aTee, [fullBuy], [human], { blockhash: sundayBlockhash });
  const [purchased, homeInfo] = await Promise.all([readPlayer(), aTee.getAccountInfo(islands[0])]);
  const home = decode<Island>("island", homeInfo);
  assert.equal(purchased.rots, STAKE);
  assert.equal(purchased.coins.toNumber(), START_COINS - STAKE * home.sundayPrice);
  await send("request gate at house island 1", aTee, [await requestGate(1)], [human]);
  await waitWeek("crank to grant gate 1", (week) => Boolean(week.gatesOpen[1] & 1));

  const [allowed, denied, unopened, privatePass] = await Promise.all([
    aTee.getAccountInfo(islands[1]),
    outsiderTee.getAccountInfo(islands[1]),
    aTee.getAccountInfo(islands[2]),
    outsiderTee.getAccountInfo(gates[1]),
  ]);
  const visited = decode<Island>("island", allowed);
  assert.equal(visited.prices.length, 12);
  assert.equal(denied, null, "A fresh key must not read island 1");
  assert.equal(unopened, null, "A must not read island 2 without its gate");
  assert.equal(privatePass, null, "The gate pass itself must stay private");
  console.log("Private reads passed for the visitor, outsider, and unopened island");

  await waitWeek("crank to open trading", (week) => phase(week, "trading"), 42_000);
  assert.ok(performance.now() - buyCardVisibleAt >= 29_000, "Monday must wait for the 30-second Sunday window");
  await send("reject sell without a gate pass", aTee, [await sell(2, 1)], [human], { error: "NoGatePass" });
  const beforeSell = await readPlayer();
  assert.equal(beforeSell.coins.toNumber(), purchased.coins.toNumber() - 20, "Grant must pay the tip");
  await send("sell on visited island", aTee, [await sell(1, 10)], [human]);
  const afterSell = await readPlayer();
  assert.equal(afterSell.rots, STAKE - 10);
  assert.ok(afterSell.coins.gt(beforeSell.coins), "Sale must credit the visitor");

  await send("owner grants gate 2", aTee, [await requestGate(2), await manageGate("openGate", 2)],
    [human, seats[2]], { units: 700_000 });
  await send("request gate 3", aTee, [await requestGate(3)], [human]);
  await waitWeek("crank to grant gate 3", (week) => Boolean(week.gatesOpen[3] & 1));
  assert.equal((await readPlayer()).passesUsed, 3);
  await send("owner closes gate 1", ownerOneTee, [await manageGate("closeGate", 1)], [seats[1]], { units: 500_000 });
  assert.equal(await aTee.getAccountInfo(islands[1]), null, "Revocation must remove price access");
  await send("reject sell after gate revocation", aTee, [await sell(1, 1)], [human], { error: "NoGatePass" });
  await send("reject fourth gate pass", aTee, [await requestGate(1)], [human], { error: "PassLimit" });
  assert.equal((await readPlayer()).rots, STAKE - 10, "Unsold Rots must remain until rot");

  const tradingTicks = new Map<number, number>();
  let previousTick: number | undefined;
  const rotted = await waitWeek("crank to rot tick 13", (week) => {
    if (phase(week, "trading")) {
      assert.equal(week.tickMs, TICK_MS);
      assert.equal(week.nextTickTs.sub(week.sundayEndTs).toNumber(), week.tick * (TICK_MS / 1_000));
      // The first snapshot may be partway through its tick. Time observed boundaries.
      if (previousTick !== undefined && week.tick !== previousTick) {
        tradingTicks.set(week.tick, performance.now());
      }
      previousTick = week.tick;
    }
    return phase(week, "rotted");
  }, 145_000);
  const intervals = [...tradingTicks.entries()].flatMap(([tick, seen]) => {
    const next = tradingTicks.get(tick + 1);
    return next === undefined ? [] : [next - seen];
  });
  assert.ok(intervals.length >= 2, "Must observe at least two consecutive crank intervals");
  assert.ok(
    intervals.every((ms) => ms >= 7_500 && ms <= 12_500),
    `Crank intervals should be near 10 seconds, observed ${intervals.map(Math.round).join(", ")} ms`,
  );
  assert.equal(rotted.tick, 13);

  const revealed = await outsiderTee.getMultipleAccountsInfo([...participants, ...gates.slice(1)]);
  const prices = revealed.slice(0, 4).map((info) => decode<Island>("island", info));
  assert.deepEqual(prices.map(({ pattern }) => pattern).sort((a, b) => a - b), [0, 1, 2, 3]);
  const finalPlayers = revealed.slice(4, 8).map((info) => decode<Player>("player", info));
  for (const [index, player] of finalPlayers.entries()) {
    assert.equal(player.rots, 0, `Player ${index} must rot to zero`);
    assert.ok(player.owner.equals(seats[index].publicKey));
    assert.ok(rotted.scoreboard[index].owner.equals(player.owner));
    assert.ok(rotted.scoreboard[index].coins.eq(player.coins));
    assert.equal(player.bought, true, `Player ${index} must have bought Rots`);
  }
  assert.ok(revealed.slice(8).every((info) => info?.owner.equals(PROGRAM_ID)), "All three passes must become public");
  assert.ok(finalPlayers.slice(1).some((player, index) =>
    player.coins.toNumber() > START_COINS - STAKE * prices[index + 1].sundayPrice + 20));
  console.log("Crank timing, rot, public reveal, bot sales, and scoreboard passed");

  const settleSignature = await send("settle on the TEE", creatorTee, [await ix("settle", [], {
    week: weekKey, payer: creator, magicContext: MAGIC_CONTEXT_ID, magicProgram: MAGIC_PROGRAM_ID,
  }, metas(participants))], [deployer], { units: 800_000 });
  await waitFor("settled and undelegated accounts on Solana devnet", 65_000, async () => {
    const infos = await base.getMultipleAccountsInfo([weekKey, ...participants]);
    if (!infos.every((info) => info?.owner.equals(PROGRAM_ID))) return undefined;
    const settled = decode<Week>("week", infos[0]);
    if (!phase(settled, "settled")) return undefined;
    assert.equal(settled.tick, 13);
    assert.deepEqual(settled.scoreboard, rotted.scoreboard);
    return true;
  }, 1_000);
  console.log(`DEVNET_EVIDENCE ${JSON.stringify({
    week: weekKey.toBase58(), delegationSignature, vrfSignature, settleSignature,
  })}`);
}
