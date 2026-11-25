import { BN } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  client, decode, gateAddress, instruction, messageOf, playerAddress, sendSigned,
  signSundayOpening, sleep, sundayInstruction, teeConnection, weekAddresses,
  type Island, type Player, type SetupStep, type Week, type WeekReceipt,
} from "./chain";

const SESSION_KEY = "rotfolio.session.v1";
const WEEK_KEY = "rotfolio.week.v1";
const WEEK_API_ORIGIN = import.meta.env.VITE_WEEK_API_ORIGIN?.replace(/\/$/, "") ?? "";

function sessionKey() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
    } catch {
      localStorage.removeItem(WEEK_KEY);
    }
  }
  localStorage.removeItem(WEEK_KEY);
  const created = Keypair.generate();
  localStorage.setItem(SESSION_KEY, JSON.stringify(Array.from(created.secretKey)));
  return created;
}

let currentSession: { key: Keypair; abort: AbortController; tee: ReturnType<typeof teeConnection> } | undefined;

function browserSession() {
  if (!currentSession) {
    const key = sessionKey();
    const abort = new AbortController();
    currentSession = { key, abort, tee: teeConnection(key, abort.signal) };
  }
  return currentSession;
}

export function clearWeek() {
  currentSession?.abort.abort();
  currentSession = undefined;
  localStorage.removeItem(WEEK_KEY);
  localStorage.removeItem(SESSION_KEY);
}

export function storedWeek(): WeekReceipt | null {
  try {
    const receipt = JSON.parse(localStorage.getItem(WEEK_KEY) ?? "null");
    if (receipt && typeof receipt.address === "string" && typeof receipt.delegation === "string") {
      new PublicKey(receipt.address);
      browserSession();
      return localStorage.getItem(WEEK_KEY) ? receipt : null;
    }
  } catch {
    localStorage.removeItem(WEEK_KEY);
  }
  return null;
}

export function storeWeek(receipt: WeekReceipt) {
  localStorage.setItem(WEEK_KEY, JSON.stringify(receipt));
  return receipt;
}

async function api<T>(action: string, data: object, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(110_000);
  const response = await fetch(`${WEEK_API_ORIGIN}/api/week/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const content = response.headers.get("Content-Type");
  if (!content?.startsWith("application/json")) {
    if (!response.ok) {
      const text = content?.startsWith("text/plain") ? (await response.text()).trim() : "";
      throw new Error(text || `The week relay returned HTTP ${response.status}.`);
    }
    throw new Error("Live play needs a configured devnet week relay.");
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The devnet week relay could not complete that request.");
  return result;
}

export async function watchSetup(signal: AbortSignal, report: (step: SetupStep) => void) {
  try {
    signal.throwIfAborted();
    const { key } = browserSession();
    while (!signal.aborted) {
      const { step } = await api<{ step: SetupStep }>("status", { owner: key.publicKey.toBase58() }, signal);
      if (!signal.aborted) report(step);
      await sleep(500, signal);
    }
  } catch {
    // Older relays lack this endpoint. Setup still advances through the main requests.
  }
}

export async function provision(fresh: boolean, report: (step: SetupStep) => void, signal: AbortSignal) {
  signal.throwIfAborted();
  const { key: session, tee } = browserSession();
  report("prepare");
  const [offer, rpc] = await Promise.all([
    api<{ address: string; creator: string; id: string; transaction: string; ready?: WeekReceipt }>(
      "prepare", { owner: session.publicKey.toBase58(), fresh }, signal,
    ),
    tee(),
  ]);
  signal.throwIfAborted();
  if (offer.ready) return offer.ready;

  const id = new BN(offer.id, 10);
  const { week, islands } = weekAddresses(id);
  const creator = new PublicKey(offer.creator);
  const player = playerAddress(week, session.publicKey);
  const transaction = Transaction.from(Buffer.from(offer.transaction, "base64"));
  const expected = await instruction(client(rpc, session), "join", [id], {
    creator, owner: session.publicKey, week, island: islands[0], player, systemProgram: SystemProgram.programId,
  });
  // Compare compiled messages. Solana gives the fee payer writable privileges, including on join.
  const expectedTransaction = new Transaction({
    feePayer: creator, recentBlockhash: transaction.recentBlockhash,
  }).add(expected);
  if (offer.address !== week.toBase58() || !transaction.serializeMessage().equals(expectedTransaction.serializeMessage())
    || !transaction.verifySignatures(false)) {
    throw new Error("The offered transaction did not match the island join.");
  }
  transaction.partialSign(session);
  report("join");
  return api<WeekReceipt>("join", { address: offer.address, transaction: transaction.serialize().toString("base64") }, signal);
}

export const startWeek = (address: string, signal: AbortSignal) => api<WeekReceipt>("start", { address }, signal);
export const settleWeek = (address: string, signal: AbortSignal) => api<WeekReceipt>("settle", { address }, signal);

export async function controlSunday(address: string, week: Week, action: "openSunday" | "doneBuying") {
  const { key, tee, abort } = browserSession();
  const rpc = await tee();
  const program = client(rpc, key);
  const weekKey = new PublicKey(address);
  if (action === "openSunday") {
    const offer = await api<{ transaction: string }>("open-sunday", { address }, abort.signal);
    const transaction = await signSundayOpening(program, weekKey, week, key, offer.transaction);
    return sendSigned(rpc, transaction, 250, abort.signal);
  }
  const [{ blockhash: recentBlockhash }, ix] = await Promise.all([
    rpc.getLatestBlockhash("confirmed"), sundayInstruction(program, action, weekKey, week, key.publicKey),
  ]);
  const transaction = new Transaction({ feePayer: key.publicKey, recentBlockhash })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }), ix);
  transaction.sign(key);
  return sendSigned(rpc, transaction, 250, abort.signal);
}

export async function readWeek(address: string) {
  const { key: session, tee } = browserSession();
  const rpc = await tee();
  return decode<Week>(client(rpc, session), "week", await rpc.getAccountInfo(new PublicKey(address)));
}

export async function readPrivate(week: Week, address: string) {
  const { key: session, tee } = browserSession();
  const rpc = await tee();
  const program = client(rpc, session);
  const player = playerAddress(new PublicKey(address), session.publicKey);
  // Including unopened islands makes the lock reflect the TEE's actual null read.
  const [personal, ...tracks] = await rpc.getMultipleAccountsInfo([player, ...week.islands]);
  return {
    player: decode<Player>(program, "player", personal),
    islands: tracks.map((info) => decode<Island>(program, "island", info)),
  };
}

export async function trade(address: string, week: Week, action: "buy" | "requestGate" | "sell", index: number, qty: number) {
  const { key: session, tee, abort } = browserSession();
  const rpc = await tee();
  const program = client(rpc, session);
  const weekKey = new PublicKey(address);
  const island = week.islands[index];
  const accounts = {
    week: weekKey, signer: session.publicKey, player: playerAddress(weekKey, session.publicKey), island,
  };
  const preparations = {
    buy: () => instruction(program, "buy", [qty], accounts),
    requestGate: () => instruction(program, "requestGate", [index], accounts),
    sell: () => instruction(program, "sell", [index, qty], {
      ...accounts, gatePass: gateAddress(island, session.publicKey),
    }),
  };
  const [{ blockhash: recentBlockhash }, ix] = await Promise.all([
    rpc.getLatestBlockhash(), preparations[action](),
  ]);
  const transaction = new Transaction({ feePayer: session.publicKey, recentBlockhash }).add(ix);
  transaction.sign(session);
  try {
    return await sendSigned(rpc, transaction, 500, abort.signal);
  } catch (error) {
    const message = messageOf(error);
    const code = message.match(/custom program error: 0x([\da-f]+)/i);
    const reason = code && program.idl.errors?.find((item) => item.code === parseInt(code[1], 16));
    throw new Error(reason?.msg ?? message.split("\n")[0]);
  }
}
