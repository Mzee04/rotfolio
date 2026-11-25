import assert from "node:assert/strict";
import { resolve } from "node:path";
import { Keypair, Transaction, type Connection, type PublicKey } from "@solana/web3.js";
import {
  BASE_RPC, BUY_CAP, PROGRAM, START_COINS, SUNDAY_BUY_SECONDS, TICK_MS, TIP,
  client, connection, decode, explorer, gateAddress, instruction, messageOf, phaseOf, sundayInstruction, teeConnection, waitFor,
  type Island, type Player, type Week,
} from "../app/src/chain";
import { createTurboWeek, loadDevnetPayer, sendTransaction } from "../app/server/week";

const SELL_QTY = 40;
const ROT_TICK = 13;
const VISIT = 1;
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PATTERNS = ["BigSpike", "SmallSpike", "Decreasing", "Random"];

function log(tick: number, event: string, opening = "Sunday") {
  const day = tick === 0 ? opening : tick === ROT_TICK ? "Rot Sunday"
    : `${DAYS[Math.floor((tick - 1) / 2)]} ${tick % 2 ? "AM" : "PM"}`;
  console.log(`[tick ${String(tick).padStart(2, "0")} ${day}] ${event}`);
}

async function demoWeek() {
  const startedAt = performance.now();
  const base = connection(BASE_RPC);
  const payer = await loadDevnetPayer(resolve(__dirname, "../keys/deployer.json"));
  const human = Keypair.generate();
  const outsider = Keypair.generate();
  const demo = await createTurboWeek(human.publicKey, base, payer, teeConnection(payer));
  const { week, players, islands } = demo;
  const program = client(base, payer);
  const gate = gateAddress(islands[VISIT], human.publicKey);
  const join = Transaction.from(await demo.joinOffer());
  join.partialSign(human);
  demo.validateJoin(join);
  const [receipt, humanTee, outsiderTee] = await Promise.all([
    demo.provision(join),
    teeConnection(human)(),
    teeConnection(outsider)(),
  ]);
  log(0, `Four seats joined and delegated to devnet-TEE. Starting balance ${START_COINS} coins per seat.`, "Lobby");

  async function readWeek(rpc = humanTee) {
    const state = decode<Week>(program, "week", await rpc.getAccountInfo(week));
    assert.ok(state, "The Week must be readable");
    return state;
  }

  async function readSeat(rpc: Connection, playerAddress: PublicKey) {
    const [weekInfo, playerInfo] = await rpc.getMultipleAccountsInfo([week, playerAddress]);
    const state = decode<Week>(program, "week", weekInfo);
    const player = decode<Player>(program, "player", playerInfo);
    assert.ok(state && player, "The seat must have access to its player and the Week");
    return { state, player };
  }

  async function readIsland(rpc: Connection, index: number) {
    const track = decode<Island>(program, "island", await rpc.getAccountInfo(islands[index]));
    assert.ok(track, `Expected access to Island ${index}`);
    return track;
  }

  const [lobby, [outsiderHome, outsiderPlayer]] = await Promise.all([
    readSeat(humanTee, players[0]),
    outsiderTee.getMultipleAccountsInfo([islands[0], players[0]]),
    readIsland(humanTee, 0),
  ]);
  assert.equal(lobby.player.coins.toNumber(), START_COINS);
  assert.equal(outsiderHome, null);
  assert.equal(outsiderPlayer, null);
  log(0, "Privacy check: owner read Island 0 and its balance. Fresh non-member got null for both.", "Lobby");

  const signer = human.publicKey;
  const [buy, requestGate, sell] = await Promise.all([
    instruction(program, "buy", [BUY_CAP], { week, signer, player: players[0], island: islands[0] }),
    instruction(program, "requestGate", [VISIT], { week, signer, player: players[0], island: islands[VISIT] }),
    instruction(program, "sell", [VISIT, SELL_QTY], {
      week, signer, player: players[0], island: islands[VISIT], gatePass: gate,
    }),
  ]);
  await demo.start();
  const seeded = await readWeek();
  assert.ok(seeded.seeded);
  assert.equal(phaseOf(seeded), "lobby");
  assert.equal(seeded.sundayEndTs.toNumber(), 0);
  const home = await readIsland(humanTee, 0);
  const openSunday = await sundayInstruction(program, "openSunday", week, seeded, signer);
  log(0, "Buy card ready after VRF. Opening the buy window.", "Lobby");
  await sendTransaction(humanTee, payer, [openSunday], { cosigners: [human] });
  const sunday = await waitFor("the Sunday buy window", 10_000, async () => {
    const state = await readWeek();
    return phaseOf(state) === "sunday" ? state : undefined;
  }, 350);
  assert.equal(sunday.tickMs, TICK_MS);
  assert.equal(sunday.sundayEndTs.sub(sunday.startTs).toNumber(), SUNDAY_BUY_SECONDS);
  log(0, `Buy window open for ${SUNDAY_BUY_SECONDS}s. Trading ticks are ${TICK_MS / 1_000}s.`);
  const purchase = await sendTransaction(humanTee, human, [buy]);
  assert.ok(receipt.vrf, "The week must have a confirmed VRF request");
  const postBuy = await readSeat(humanTee, players[0]);
  const buyBalance = START_COINS - BUY_CAP * home.sundayPrice;
  assert.equal(postBuy.player.rots, BUY_CAP);
  assert.equal(postBuy.player.coins.toNumber(), buyBalance);
  log(0, `Human bought ${BUY_CAP} Rots at ${home.sundayPrice} coins each. Balance ${buyBalance} coins.`);

  log(postBuy.state.tick, `Requesting Island ${VISIT} gate. Tip ${TIP} coins on grant.`);
  const request = await sendTransaction(humanTee, human, [requestGate]);

  let current = await readWeek();
  let visited: Island | undefined;
  let sale: string | undefined;
  let lastTick = -1;
  while (phaseOf(current) !== "rotted") {
    if (current.tick !== lastTick) {
      lastTick = current.tick;
      if (current.tick > 0) {
        const price = visited ? ` · Island ${VISIT} ${visited.prices[current.tick - 1]}` : "";
        log(current.tick, `Live price in coins per Rot: Island 0 ${home.prices[current.tick - 1]}${price}.`);
      }
    }

    if (!visited && (current.gatesOpen[VISIT] & 1)) {
      const [track, denied, unopened, { player }] = await Promise.all([
        readIsland(humanTee, VISIT),
        outsiderTee.getAccountInfo(islands[VISIT]),
        humanTee.getAccountInfo(islands[2]),
        readSeat(humanTee, players[0]),
      ]);
      assert.equal(denied, null);
      assert.equal(unopened, null);
      assert.equal(player.passesUsed, 1);
      assert.equal(player.coins.toNumber(), buyBalance - TIP);
      visited = track;
      log(current.tick, `Crank granted Island ${VISIT} for ${TIP} coins. Member read OK. Non-member and unopened Island 2 reads null 🔒.`);
    }

    if (visited && !sale && phaseOf(current) === "trading") {
      const before = await readSeat(humanTee, players[0]);
      sale = await sendTransaction(humanTee, human, [sell]);
      const after = await readSeat(humanTee, players[0]);
      assert.equal(after.player.rots, BUY_CAP - SELL_QTY);
      const unitPrice = after.player.coins.sub(before.player.coins).toNumber() / SELL_QTY;
      const possiblePrices = visited.prices.slice(before.state.tick - 1, after.state.tick);
      assert.ok(possiblePrices.includes(unitPrice), "Sale proceeds must match a live market price");
      log(after.state.tick, `Human sold ${SELL_QTY} Rots on Island ${VISIT} at ${unitPrice} coins each. ${after.player.rots} Rots remain.`);
    }

    current = await waitFor("the next crank tick", 16_000, async () => {
      const state = await readWeek();
      return state.tick > lastTick ? state : undefined;
    }, 750);
  }

  assert.equal(current.tick, ROT_TICK);
  assert.ok(visited && sale, "A member-authorized sale must complete");

  const publicAccounts = await outsiderTee.getMultipleAccountsInfo([...islands, ...players, gate]);
  const publicIslands = publicAccounts.slice(0, 4).map((info, index) => {
    const island = decode<Island>(program, "island", info);
    assert.ok(island, `Island ${index} must be public after rot`);
    assert.equal(island.prices.length, 12);
    return island;
  });
  const patterns = publicIslands.map((island) => PATTERNS[island.pattern]);
  assert.deepEqual([...patterns].sort(), [...PATTERNS].sort());
  const scores = current.scoreboard.map(({ coins }) => coins.toNumber());
  const publicPlayers = publicAccounts.slice(4, 8).map((info) => decode<Player>(program, "player", info));
  for (const [index, player] of publicPlayers.entries()) {
    assert.ok(player?.bought);
    assert.equal(player.rots, 0);
    assert.equal(player.coins.toNumber(), scores[index]);
  }
  assert.ok(publicAccounts[8]?.owner.equals(PROGRAM), "The granted pass must become public");
  log(ROT_TICK, `${BUY_CAP - SELL_QTY} unsold human Rots expired. Fresh non-member read all four tracks, all four balances, and the gate pass.`);
  log(ROT_TICK, `Revealed patterns: ${patterns.map((pattern, index) => `Island ${index} ${pattern}`).join(", ")}.`);

  // Bot accounts have no RPC members while trading. After rot, subtract the
  // Sunday purchase and gate tip before attributing the remaining coins to a sale.
  let botSales = 0;
  for (let index = 1; index < publicIslands.length; index++) {
    const track = publicIslands[index];
    const tip = index === VISIT ? TIP : 0;
    const afterBuy = START_COINS - BUY_CAP * track.sundayPrice + tip;
    const proceeds = scores[index] - afterBuy;
    if (proceeds === 0) continue;
    const saleIndex = track.prices.findIndex((price, offset) =>
      offset === 10 || price * 10 >= track.sundayPrice * 13);
    assert.ok(saleIndex >= 0, "The bot must have a qualifying crank sell tick");
    assert.equal(proceeds, BUY_CAP * track.prices[saleIndex], `Island ${index} crank sale proceeds`);
    botSales++;
    log(ROT_TICK, `Crank sale verified: Island ${index} bot sold ${BUY_CAP} Rots at ${track.prices[saleIndex]} coins each (tick ${saleIndex + 1}).`);
  }
  assert.ok(botSales >= 1, "At least one crank bot must sell");
  log(ROT_TICK, `Scoreboard: ${scores.map((score, index) => `Island ${index} ${score}`).join(", ")} coins.`);

  const settled = await demo.settle();
  assert.deepEqual(settled.final?.scores, scores);
  assert.ok(settled.settle, "A confirmed settle transaction is required");
  log(ROT_TICK, "Settled. Week, islands, and players are undelegated on Solana devnet.");
  console.log(`Program: ${explorer("address", PROGRAM.toBase58())}`);
  console.log(`Week: ${explorer("address", week.toBase58())}`);
  console.log(`Delegation: ${explorer("tx", receipt.delegation)}`);
  console.log(`VRF request: ${explorer("tx", receipt.vrf, true)}`);
  console.log(`Human buy / gate request / sale: ${[purchase, request, sale].map((sig) => explorer("tx", sig, true)).join(" | ")}`);
  console.log(`Settle: ${explorer("tx", settled.settle, true)}`);
  console.log(`PASS · 1 BigSpike · ${botSales} crank bot sales · ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
}

void demoWeek().catch((error) => {
  console.error(`FAIL · ${messageOf(error).split("\n")[0]}`);
  process.exitCode = 1;
});
