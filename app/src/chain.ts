import { AnchorProvider, Program, utils, type BN, type Idl } from "@coral-xyz/anchor";
import { EPHEMERAL_VAULT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID, getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  Connection, Keypair, PublicKey, Transaction, VersionedTransaction,
  type AccountInfo, type AccountMeta, type TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import nacl from "tweetnacl";
import idl from "./rotfolio.json";

export const BASE_RPC = "https://api.devnet.solana.com";
export const TEE_RPC = "https://devnet-tee.magicblock.app";
export const PROGRAM = new PublicKey(idl.address);
export const START_COINS = 12_000;
export const BUY_CAP = 100;
export const PASS_CAP = 3;
export const TIP = 20;
export const TICK_MS = 10_000;
export const SUNDAY_BUY_SECONDS = 30;
export const TRADING_TICKS = 12;

export const rollup = {
  permissionProgram: PERMISSION_PROGRAM_ID,
  ephemeralVault: EPHEMERAL_VAULT_ID,
  magicProgram: MAGIC_PROGRAM_ID,
};

export type Phase = "lobby" | "sunday" | "trading" | "rotted" | "settled";
export type Week = {
  creator: PublicKey;
  phase: Partial<Record<Phase, object>>;
  tick: number;
  tickMs: number;
  startTs: BN;
  sundayEndTs: BN;
  islands: PublicKey[];
  players: PublicKey[];
  gatesOpen: number[];
  seeded: boolean;
  scoreboard: { owner: PublicKey; coins: BN }[];
};
export type Island = { pattern: number; sundayPrice: number; prices: number[] };
export type Player = { coins: BN; rots: number; bought: boolean; passesUsed: number };
export type AccountMap = Record<string, PublicKey | Record<string, PublicKey>>;
export type SetupStep = "prepare" | "join" | "delegate" | "permissions" | "start" | "vrf";

export type WeekReceipt = {
  address: string;
  delegation: string;
  vrf?: string;
  settle?: string;
  final?: { islands: Island[]; scores: number[] };
};

export function sleep(milliseconds: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function pda(seed: string, keys: Buffer[], program = PROGRAM) {
  return PublicKey.findProgramAddressSync([Buffer.from(seed), ...keys], program)[0];
}

export function weekAddresses(id: BN) {
  const week = pda("week", [id.toArrayLike(Buffer, "le", 8)]);
  const islands = Array.from({ length: 4 }, (_, index) =>
    pda("island", [week.toBuffer(), Buffer.from([index])]));
  return { week, islands };
}

export function playerAddress(week: PublicKey, owner: PublicKey) {
  return pda("player", [week.toBuffer(), owner.toBuffer()]);
}

export function gateAddress(island: PublicKey, visitor: PublicKey) {
  return pda("gate", [island.toBuffer(), visitor.toBuffer()]);
}

export function marketMetas(islands: PublicKey[], players: PublicKey[], human: PublicKey): AccountMeta[] {
  const participants = [...islands, ...players];
  const gates = islands.slice(1).map((island) => gateAddress(island, human));
  const permission = (key: PublicKey) => pda("permission:", [key.toBuffer()], PERMISSION_PROGRAM_ID);
  return [...participants, ...participants.map(permission), ...gates, ...gates.map(permission)]
    .map((pubkey) => ({ pubkey, isWritable: true, isSigner: false }));
}

export function sundayInstruction(
  program: Program, action: "openSunday" | "doneBuying", week: PublicKey,
  { creator, islands, players }: Pick<Week, "creator" | "islands" | "players">, signer: PublicKey,
) {
  const accounts = { signer, week, rollup };
  return instruction(program, action, [], action === "openSunday" ? { ...accounts, creator } : accounts,
    marketMetas(islands, players, signer));
}

export async function signSundayOpening(program: Program, address: PublicKey, week: Week, owner: Keypair, offer: string) {
  const transaction = Transaction.from(Buffer.from(offer, "base64"));
  const ix = await sundayInstruction(program, "openSunday", address, week, owner.publicKey);
  const expected = new Transaction({ feePayer: week.creator, recentBlockhash: transaction.recentBlockhash }).add(ix);
  if (!transaction.serializeMessage().equals(expected.serializeMessage()) || !transaction.verifySignatures(false)) {
    throw new Error("The offered transaction did not match this week's Sunday opening.");
  }
  transaction.partialSign(owner);
  return transaction;
}

export function phaseOf(week: Week): Phase {
  return Object.keys(week.phase)[0] as Phase;
}

export function messageOf(error: unknown) {
  const message = error instanceof Error ? error.message : "An unexpected error occurred.";
  return message.replace(/([?&]token=)[^&\s"']+/gi, "$1[redacted]");
}

function retryingFetch(scope?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const signal = scope && init?.signal ? AbortSignal.any([scope, init.signal]) : scope ?? init?.signal ?? undefined;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const timeout = AbortSignal.timeout(8_000);
        const response = await fetch(input, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        if ((response.status !== 429 && response.status < 500) || attempt === 4) return response;
        const retryAfter = Number(response.headers.get("Retry-After")) || 0;
        await response.body?.cancel();
        await sleep(Math.min(8_000, Math.max(350 * 2 ** attempt, retryAfter * 1_000)), signal);
      } catch (error) {
        if (attempt === 4) throw error;
        await sleep(150 * (attempt + 1), signal);
      }
    }
  };
}

export function connection(url: string, signal?: AbortSignal) {
  return new Connection(url, { commitment: "confirmed", disableRetryOnRateLimit: true, fetch: retryingFetch(signal) });
}

export function teeConnection(session: Keypair, signal?: AbortSignal) {
  let cached: { connection: Connection; expiresAt: number } | undefined;
  let pending: Promise<Connection> | undefined;
  return async () => {
    signal?.throwIfAborted();
    if (cached && Date.now() < cached.expiresAt - 600_000) return cached.connection;
    pending ??= getAuthToken(TEE_RPC, session.publicKey, async (message) =>
      nacl.sign.detached(message, session.secretKey),
    ).then(({ token, expiresAt }) => {
      signal?.throwIfAborted();
      const rpc = connection(`${TEE_RPC}?token=${encodeURIComponent(token)}`, signal);
      cached = { connection: rpc, expiresAt };
      return rpc;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

export function client(rpc: Connection, signer: Keypair) {
  async function signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    if (transaction instanceof Transaction) transaction.partialSign(signer);
    else transaction.sign([signer]);
    return transaction;
  }

  const provider = new AnchorProvider(rpc, {
    publicKey: signer.publicKey,
    signTransaction,
    signAllTransactions: (transactions) => Promise.all(transactions.map(signTransaction)),
  }, AnchorProvider.defaultOptions());
  return new Program(idl as Idl, provider);
}

export function instruction(
  program: Program, name: string, args: unknown[], accounts: AccountMap, extra: AccountMeta[] = [],
): Promise<TransactionInstruction> {
  return program.methods[name](...args).accountsStrict(accounts).remainingAccounts(extra).instruction();
}

export function decode<T>(program: Program, kind: string, info: AccountInfo<Buffer> | null): T | null {
  return info?.owner.equals(PROGRAM) ? program.coder.accounts.decode<T>(kind, info.data) : null;
}

export async function waitFor<T>(label: string, timeout: number, read: () => Promise<T | undefined>, period = 800) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await read();
      if (result !== undefined) return result;
    } catch (error) {
      if (!/fetch failed|TimeoutError|429 Too Many Requests/i.test(messageOf(error))) throw error;
    }
    await sleep(period);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export async function sendSigned(rpc: Connection, tx: Transaction, pollInterval = 500, signal?: AbortSignal) {
  if (!tx.signature) throw new Error("Missing transaction signature.");
  const signature = utils.bytes.bs58.encode(tx.signature);
  try {
    signal?.throwIfAborted();
    await rpc.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed", maxRetries: 2 });
  } catch (error) {
    if (!/already been processed/i.test(messageOf(error))) throw error;
  }
  await waitFor("transaction confirmation", 25_000, async () => {
    signal?.throwIfAborted();
    const { value: [status] } = await rpc.getSignatureStatuses([signature]);
    if (status?.err) throw new Error(`The transaction was declined (${JSON.stringify(status.err)}).`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return true;
  }, pollInterval);
  return signature;
}

export function explorer(kind: "address" | "tx", value: string, onTee = false) {
  const network = onTee ? `custom&customUrl=${encodeURIComponent(TEE_RPC)}` : "devnet";
  return `https://explorer.solana.com/${kind}/${value}?cluster=${network}`;
}
