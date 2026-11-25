import { useEffect, useId, useRef, useState } from "react";
import { Chart, tickLabel } from "./Chart";
import { HowToPlay } from "./HowToPlay";
import {
  BUY_CAP, PASS_CAP, PROGRAM, START_COINS, SUNDAY_BUY_SECONDS, TICK_MS, TIP, TRADING_TICKS, explorer, messageOf, phaseOf, sleep, waitFor,
  type Island, type Player, type SetupStep, type Week, type WeekReceipt,
} from "./chain";
import {
  clearWeek, controlSunday, provision, readPrivate, readWeek, settleWeek, startWeek, storeWeek, storedWeek, trade, watchSetup,
} from "./market";
import { clampSellDraft, confirmedSalePrice } from "./trade-feedback";
import "./style.css";

type Screen = "Lobby" | "My Island" | "Archipelago" | "Reveal";
type AbandonAction = "reset" | "restart";
type Private = { player: Player | null; islands: (Island | null)[] };
type Notice = { text: string; screen: Screen };
type Sale = { before: Player; qty: number; index: number; screen: Screen };
const SCREENS: Screen[] = ["Lobby", "My Island", "Archipelago"];
const ISLANDS = ["Sundrift", "Ember Cay", "Verdant Isle", "Moonwake"];
const COLORS = ["#fac464", "#f39691", "#74dcc3", "#acb2ff"];
const PATTERNS = ["Big Spike", "Small Spike", "Decreasing", "Random"];
const SETUP_LABELS: Record<SetupStep, string> = {
  prepare: "Creating week 1/5…",
  join: "Joining seats 2/5…",
  delegate: "Delegating accounts 3/5…",
  permissions: "Setting permissions 4/5…",
  start: "Starting week 5/5…",
  vrf: "Waiting for VRF 5/5…",
};
const SETUP_STEPS = Object.keys(SETUP_LABELS);
const GUIDE_DISMISSED = "rotfolio.guide.dismissed.v1";
const NOTICE_MS = 3_000;
const number = new Intl.NumberFormat("en");
const empty: Private = { player: null, islands: [null, null, null, null] };

function Stat({ label, value, className = "" }: { label: string; value: string | number; className?: string }) {
  return <div className={`stat ${className}`}><span>{label}</span><strong>{value}</strong></div>;
}

function Art({ index }: { index: number }) {
  return <div aria-hidden="true" className={`island-art art-${index}`} />;
}

function Offer({ index, rots, busy, pending = false, tick, price, onSell }: {
  index: number; rots: number; busy: boolean; pending?: boolean; tick?: number; price?: number;
  onSell: (index: number, qty: number) => void;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [noticeTick, setNoticeTick] = useState<number>();
  const previousTick = useRef(tick);
  useEffect(() => {
    setDraft((current) => clampSellDraft(current, rots));
  }, [rots]);
  useEffect(() => {
    const previous = previousTick.current;
    previousTick.current = tick;
    if (previous === undefined || tick === undefined || previous === tick) return;
    setNoticeTick(tick);
    const timer = window.setTimeout(() => setNoticeTick(undefined), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [tick]);
  // An in-progress edit belongs to the player, even when a market tick updates the card.
  const value = pending ? "" : clampSellDraft(draft, rots) ?? String(rots);
  // Leave room to type a replacement. An empty field uses the minimum on blur or submit.
  const amount = value === "" && rots > 0 ? 1 : Number(value);
  const valid = !busy && !pending && amount > 0;
  return <form className="sell-form" onSubmit={(event) => {
    event.preventDefault();
    if (valid) onSell(index, amount);
  }}>
    <label htmlFor={inputId}>Rots to sell</label>
    <div className="trade-row sell-row">
      <input id={inputId} type="number" inputMode="numeric" min="1" max={Math.max(1, rots)}
        value={value} disabled={pending || rots === 0}
        onChange={(event) => setDraft(clampSellDraft(event.currentTarget.value, rots))}
        onBlur={(event) => {
          if (!pending && rots > 0) setDraft(clampSellDraft(event.currentTarget.value || "1", rots));
        }} />
      <button type="button" className="secondary sell-max" disabled={pending || rots === 0}
        onClick={() => setDraft(String(rots))}>Max</button>
      <button type="submit" disabled={!valid}>Sell</button>
    </div>
    {noticeTick !== undefined && noticeTick === tick && price !== undefined && rots > 0 && !pending &&
      <p className="tick-notice" role="status">New tick: price is now {price} coins / Rot</p>}
    {pending && <p className="muted" role="status">Waiting for {ISLANDS[index]} owner…</p>}
  </form>;
}

function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function Countdown({ week, final }: { week: Week | null; final: boolean }) {
  const now = useNow();
  const phase = week && phaseOf(week);
  const tickMs = week?.tickMs ?? TICK_MS;
  const rotAt = week ? week.sundayEndTs.toNumber() * 1000 + TRADING_TICKS * tickMs : 0;
  const remaining = Math.max(0, Math.ceil((rotAt - now) / 1_000));
  const clock = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  const ended = final || phase === "rotted" || phase === "settled";
  const remainingLabel = ended ? "0:00" : phase === "sunday" || phase === "trading" ? clock : "—";
  return <Stat className="rot-countdown" label={`Market: ${TRADING_TICKS} ticks × ${tickMs / 1_000} s`}
    value={`Unsold Rots expire in ${remainingLabel}`} />;
}

function BuyWindow({ week }: { week: Week }) {
  const now = useNow();
  const end = week.sundayEndTs.toNumber();
  const seconds = phaseOf(week) === "lobby" ? SUNDAY_BUY_SECONDS
    : Math.max(0, Math.min(end - week.startTs.toNumber(), Math.ceil(end - now / 1_000)));
  return <p className="buy-window" role="timer">Buy window: <strong>{seconds}s</strong></p>;
}

function AbandonDialog({ action, cancel, confirm }: { action: AbandonAction; cancel: () => void; confirm: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  function close(next: () => void) {
    dialog.current?.close();
    next();
  }

  return <dialog ref={dialog} className="abandon-dialog" aria-labelledby="abandon-title"
    onCancel={(event) => { event.preventDefault(); close(cancel); }}>
    <div className="guide-content">
      <h2 id="abandon-title">Abandon this week and start fresh?</h2>
      <div className="abandon-actions">
        <button className="secondary" onClick={() => close(cancel)}>Cancel</button>
        <button className="primary" onClick={() => close(confirm)}>{action === "restart" ? "Restart week" : "Reset"}</button>
      </div>
    </div>
  </dialog>;
}

function Reveal({ receipt, week, islands, settled, retry }: {
  receipt: WeekReceipt | null; week: Week | null; islands: (Island | null)[]; settled: boolean; retry: () => void;
}) {
  const scores = receipt?.final?.scores ?? week?.scoreboard.map(({ coins }) => coins.toNumber()) ?? [];
  const ranking = scores.map((coins, index) => ({ coins, index })).sort((a, b) => b.coins - a.coins);
  return <>
    <section className="panel reveal-grid" aria-label="Public price charts">
      <div className="section-title"><div><p className="eyebrow">Public at tick 13</p><h2>Every price track</h2></div></div>
      <div className="chart-grid">
        {ISLANDS.map((name, index) => {
          const island = islands[index];
          return <article className="chart-card" key={name}>
            <div className="chart-title"><h3>{name}</h3><span style={{ color: COLORS[index] }}>
              {island ? PATTERNS[island.pattern] : "Loading…"}
            </span></div>
            <Chart prices={island?.prices ?? []} color={COLORS[index]} compact />
          </article>;
        })}
      </div>
    </section>
    <div className="reveal-side">
      <section className="panel score" aria-labelledby="score-title">
        <p className="eyebrow">Final balances</p><h2 id="score-title">Scoreboard</h2>
        <ol>{ranking.map(({ index, coins }) => <li key={index}>
          <span>{ISLANDS[index]}{index === 0 && <small>You</small>}</span>
          <strong>{number.format(coins)} <small>coins</small></strong>
        </li>)}</ol>
      </section>
      <section className="panel privacy">
        <p className="eyebrow">Privacy timeline</p><h2>What was private?</h2>
        <p><strong>Before rot.</strong> Only you could read your balance and Rots. An island’s owner and active pass holders could read its price track.</p>
        <p><strong>Tick 13 · Rot Sunday.</strong> Unsold Rots expired. All four price tracks, patterns, player balances and gate passes became public. The program published the final scoreboard.</p>
        <p className="settle-status">{settled ? "Settled on Solana devnet" : "Settling to Solana devnet…"}
          {!settled && <button className="text-button" onClick={retry}>Retry settle</button>}</p>
        <div className="explorers">
          <a href={explorer("address", PROGRAM.toBase58())} target="_blank" rel="noreferrer">Program</a>
          {receipt && <a href={explorer("address", receipt.address)} target="_blank" rel="noreferrer">Week account</a>}
          {receipt?.delegation && <a href={explorer("tx", receipt.delegation)} target="_blank" rel="noreferrer">Delegation</a>}
          {receipt?.vrf && <a href={explorer("tx", receipt.vrf, true)} target="_blank" rel="noreferrer">VRF request</a>}
          {receipt?.settle && <a href={explorer("tx", receipt.settle, true)} target="_blank" rel="noreferrer">Settle transaction</a>}
        </div>
      </section>
    </div>
  </>;
}

export function App() {
  const [session, setSession] = useState({ epoch: 0, restart: false });
  return <WeekApp key={session.epoch} restartOnMount={session.restart}
    onAbandon={(restart) => setSession(({ epoch }) => ({ epoch: epoch + 1, restart }))} />;
}

function WeekApp({ restartOnMount, onAbandon }: { restartOnMount: boolean; onAbandon: (restart: boolean) => void }) {
  const [receipt, setReceipt] = useState(storedWeek);
  const [screen, setScreen] = useState<Screen>(() => receipt?.final ? "Reveal" : receipt ? "My Island" : "Lobby");
  const [guideDismissed, setGuideDismissed] = useState(() => localStorage.getItem(GUIDE_DISMISSED) === "true");
  const [guideOpen, setGuideOpen] = useState(!guideDismissed);
  const [week, setWeek] = useState<Week | null>(null);
  const [account, setAccount] = useState(empty);
  const [setup, setSetup] = useState<{ step: SetupStep; slow?: boolean; error?: string } | null>(null);
  const [abandonAction, setAbandonAction] = useState<AbandonAction | null>(null);
  const [lifetime] = useState(() => new AbortController());
  const setupAttempt = useRef<AbortController>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [buyQty, setBuyQty] = useState(BUY_CAP);
  const [pending, setPending] = useState<number[]>([]);
  const [requesting, setRequesting] = useState<number | null>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  const [purchased, setPurchased] = useState(false);
  const [sundayError, setSundayError] = useState("");
  const sundayInFlight = useRef(false);
  const buyButton = useRef<HTMLButtonElement>(null);
  const [settleAttempt, setSettleAttempt] = useState(0);
  const guideButton = useRef<HTMLButtonElement>(null);
  const guideInvoker = useRef<HTMLButtonElement>(null);
  const latestWeek = useRef<Week | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const address = receipt?.address;
  const final = Boolean(receipt?.final);
  const phase = week ? phaseOf(week) : "lobby";
  const revealed = final || phase === "rotted" || phase === "settled";
  const trading = phase === "trading";
  const open = phase === "sunday" || trading;
  const gatesOpen = week?.gatesOpen;
  const activePending = pending.filter((index) => !((gatesOpen?.[index] ?? 0) & 1));
  const visibleTick = final ? TRADING_TICKS : Math.min(week?.tick ?? 0, TRADING_TICKS);
  const islands = receipt?.final?.islands ?? account.islands;
  const player = account.player;
  const held = sale ? Math.min(player?.rots ?? 0, sale.before.rots - sale.qty) : player?.rots ?? 0;
  const coins = receipt?.final?.scores[0] ?? player?.coins.toNumber();
  const home = islands[0];
  const homeLive = home && trading ? home.prices[visibleTick - 1] : undefined;
  const readyToOpen = !setup && phase === "lobby" && week?.tickMs === TICK_MS
    && week.seeded && Boolean(home) && Boolean(player);
  const buying = phase === "sunday" && Boolean(home) && Boolean(player) && !(purchased || player?.bought);
  const skippedBuy = (trading || revealed) && player?.bought === false && !purchased && !busy;

  useEffect(() => {
    if (!notice) return;
    if (notice.screen !== screen) {
      setNotice(null);
      return;
    }
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, screen]);

  useEffect(() => {
    if (!sale) return;
    // A refresh may share an in-flight read from before confirmation. Wait for the inventory change.
    const updated = player && player.rots <= sale.before.rots - sale.qty ? player : null;
    if (!updated && !revealed) return;
    const price = updated ? confirmedSalePrice(sale.before, updated, sale.qty) : undefined;
    const atPrice = price === undefined ? "" : ` at ${price} coins / Rot`;
    setSale(null);
    setNotice({ screen: sale.screen, text: `Sold ${sale.qty} Rots on ${ISLANDS[sale.index]}${atPrice}.` });
  }, [sale, player, revealed]);

  useEffect(() => {
    if (!gatesOpen || pending.length === 0) return;
    const granted = pending.filter((index) => gatesOpen[index] & 1);
    if (granted.length === 0) return;
    setPending((current) => current.filter((index) => !granted.includes(index)));
    const names = granted.map((index) => ISLANDS[index]).join(", ");
    const label = granted.length === 1 ? "Visit granted" : "Visits granted";
    setNotice({ screen, text: `${label} at ${names}.` });
  }, [gatesOpen, pending, screen]);

  useEffect(() => {
    if (!address || final) return;
    const pollAbort = new AbortController();
    const signal = AbortSignal.any([pollAbort.signal, lifetime.signal]);
    const report = (cause: unknown) => { if (!signal.aborted) setError(messageOf(cause)); };
    const pollWeek = async () => {
      const data = await readWeek(address);
      if (!signal.aborted && data) {
        latestWeek.current = data;
        setWeek(data);
      }
    };
    let privateRead: Promise<void> | undefined;
    const pollPrivate = () => {
      const data = latestWeek.current;
      if (!data || signal.aborted) return Promise.resolve();
      privateRead ??= readPrivate(data, address).then((accounts) => {
        if (!signal.aborted) setAccount(accounts);
      }).finally(() => { privateRead = undefined; });
      return privateRead;
    };
    refresh.current = pollPrivate;
    async function poll(action: () => Promise<void>, normal: number, opening: number) {
      while (!signal.aborted) {
        const start = Date.now();
        try { await action(); } catch (cause) { report(cause); }
        const current = latestWeek.current;
        const interval = current && phaseOf(current) !== "lobby" ? normal : opening;
        try { await sleep(Math.max(0, interval - (Date.now() - start)), signal); } catch { return; }
      }
    }
    void poll(async () => {
      const initial = !latestWeek.current;
      await pollWeek();
      if (initial) await pollPrivate();
    }, 1_000, 300);
    void poll(pollPrivate, 1_500, 450);
    return () => { pollAbort.abort(); refresh.current = async () => {}; };
  }, [address, final, lifetime]);

  useEffect(() => {
    if (!address || !revealed || final) return;
    setScreen("Reveal");
    setNotice(null);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    void settleWeek(address, signal).then((settled) => {
      if (!signal.aborted) setReceipt((previous) => signal.aborted ? previous : storeWeek({ ...previous, ...settled }));
    }).catch((cause) => { if (!signal.aborted) setError(messageOf(cause)); });
    return () => controller.abort();
  }, [address, revealed, final, lifetime, settleAttempt]);

  async function runSetup(saved?: WeekReceipt, fresh = false) {
    setupAttempt.current?.abort();
    const controller = new AbortController();
    setupAttempt.current = controller;
    const signal = AbortSignal.any([controller.signal, lifetime.signal]);
    setSetup({ step: saved ? "start" : "prepare" });
    setError("");
    setNotice(null);
    if (!saved) {
      latestWeek.current = null;
      setWeek(null);
      setAccount(empty);
      setPurchased(false);
      setSundayError("");
      setPending([]);
      setSale(null);
      setBuyQty(BUY_CAP);
      setScreen("Lobby");
    }
    const timeout = window.setTimeout(() => {
      if (!signal.aborted) setSetup((current) => current && { ...current, slow: true });
    }, 60_000);
    signal.addEventListener("abort", () => window.clearTimeout(timeout), { once: true });

    const report = (step: SetupStep) => {
      if (!signal.aborted && SETUP_STEPS.includes(step)) {
        setSetup((current) => current && SETUP_STEPS.indexOf(step) > SETUP_STEPS.indexOf(current.step)
          ? { ...current, step } : current);
      }
    };
    void watchSetup(signal, report);
    try {
      const next = saved ?? await provision(fresh, report, signal);
      signal.throwIfAborted();
      setReceipt(storeWeek(next));
      report("start");
      const started = await startWeek(next.address, signal);
      signal.throwIfAborted();
      report("vrf");
      // Some older relays return after submitting a VRF retry. The Week must be seeded before play begins.
      await waitFor("the VRF callback", 30_000, async () => {
        signal.throwIfAborted();
        return latestWeek.current?.seeded ? true : undefined;
      }, 250);
      signal.throwIfAborted();
      setReceipt(storeWeek({ ...next, ...started }));
      setScreen(latestWeek.current && phaseOf(latestWeek.current) === "rotted" ? "Reveal" : "My Island");
      setSetup(null);
    } catch (cause) {
      if (!signal.aborted) {
        setSetup((current) => current && { ...current, error: messageOf(cause) });
      }
    } finally {
      controller.abort();
      window.clearTimeout(timeout);
    }
  }

  useEffect(() => {
    if (restartOnMount) void runSetup();
    else if (receipt && !receipt.vrf && !receipt.final) void runSetup(receipt);
    return () => lifetime.abort();
    // Initial entry only. Retry and restart are driven by the controls.
  }, []);

  function play() {
    if (address && !final) { setScreen("My Island"); return; }
    void runSetup(undefined, final);
  }

  function abandon(restart: boolean) {
    lifetime.abort();
    clearWeek();
    onAbandon(restart);
  }

  async function act(action: "buy" | "requestGate" | "sell", index: number, qty = 0) {
    if (!address || !week || busy || (action === "sell" && (!player || sale))) return;
    setBusy(true);
    if (action === "requestGate") setRequesting(index);
    setError("");
    setNotice(null);
    try {
      await trade(address, week, action, index, qty);
      if (lifetime.signal.aborted) return;
      if (action === "buy") {
        setPurchased(true);
        setNotice({ screen, text: `Bought ${qty} Rots.` });
      } else if (action === "requestGate") {
        setPending((previous) => [...previous, index]);
      } else if (player) {
        setSale({ before: player, qty, index, screen });
      }
    } catch (cause) {
      if (!lifetime.signal.aborted) setError(messageOf(cause));
    } finally {
      if (!lifetime.signal.aborted) {
        if (action === "requestGate") setRequesting(null);
        try { await refresh.current(); } catch { /* The regular poll will retry the read. */ }
        setBusy(false);
      }
    }
  }

  async function actSunday(action: "openSunday" | "doneBuying") {
    if (!address || !week || sundayInFlight.current) return;
    sundayInFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await controlSunday(address, week, action);
      if (lifetime.signal.aborted) return;
      const state = await readWeek(address);
      if (state && !lifetime.signal.aborted) {
        latestWeek.current = state;
        setWeek(state);
      }
    } catch (cause) {
      if (lifetime.signal.aborted) return;
      if (action === "openSunday") setSundayError(messageOf(cause));
      else setError(messageOf(cause));
    } finally {
      sundayInFlight.current = false;
      if (!lifetime.signal.aborted) setBusy(false);
    }
  }

  useEffect(() => {
    const button = buyButton.current;
    if (screen !== "My Island" || !readyToOpen || !button || sundayError || abandonAction || guideOpen) return;
    let frame = 0;
    let visible = false;
    const openAfterPaint = () => {
      if (!visible || document.hidden || frame || sundayInFlight.current || lifetime.signal.aborted) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (visible && !document.hidden && !lifetime.signal.aborted) void actSunday("openSunday");
        });
      });
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.intersectionRatio >= 0.5;
      openAfterPaint();
    }, { threshold: 0.5 });
    observer.observe(button);
    document.addEventListener("visibilitychange", openAfterPaint);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", openAfterPaint);
    };
  }, [screen, readyToOpen, address, sundayError, abandonAction, guideOpen, lifetime]);

  function showGuide(invoker: HTMLButtonElement) {
    guideInvoker.current = invoker;
    setGuideOpen(true);
  }

  function dismissGuide() {
    try { localStorage.setItem(GUIDE_DISMISSED, "true"); } catch { /* Keep it dismissed for this visit. */ }
    setGuideDismissed(true);
    setGuideOpen(false);
    (guideInvoker.current?.isConnected ? guideInvoker.current : guideButton.current)?.focus();
  }

  function canBuy(quantity: number) {
    return buying && !busy && quantity >= 1 && quantity <= BUY_CAP
      && Boolean(player && home && player.coins.toNumber() >= quantity * home.sundayPrice);
  }

  function buy(quantity: number) {
    if (canBuy(quantity)) void act("buy", 0, quantity);
  }

  function screenButton(item: Screen) {
    return <button key={item} aria-current={screen === item ? "page" : undefined}
      disabled={(item !== "Lobby" && !address) || (item === "Reveal" && !revealed)}
      onClick={() => setScreen(item)}>{item}</button>;
  }

  return <div className="shell">
    <header className="header">
      <button type="button" className="wordmark" onClick={() => setScreen("Lobby")}>Rotfolio<span>.</span></button>
      <nav aria-label="Game screens">
        {SCREENS.map(screenButton)}
        <div className="nav-actions">
          {screenButton("Reveal")}
          <button type="button" className="guide-toggle" ref={guideButton} aria-haspopup="dialog" aria-controls="how-to-play"
            onClick={(event) => showGuide(event.currentTarget)}>
            <span className="guide-icon" aria-hidden="true">?</span>How to play
          </button>
          <span className="network"><i /> Devnet</span>
        </div>
      </nav>
    </header>
    <main>
      {setup && <section className="setup-panel" aria-label="Week setup">
        <div>
          <p role="status" className="setup-title">
            {setup.slow ? "Setup is taking longer than usual" : setup.error ? "Setup paused" : SETUP_LABELS[setup.step]}
          </p>
          {setup.slow && !setup.error && <p className="muted">{SETUP_LABELS[setup.step]}</p>}
          {setup.error && <p className="setup-error" role="alert">{setup.error}</p>}
        </div>
        <div className="setup-actions">
          {(setup.slow || setup.error) && <button className="primary"
            onClick={() => void runSetup(receipt && !receipt.final ? receipt : undefined, final)}>Retry</button>}
          <button className="secondary" onClick={() => setAbandonAction("reset")}>Reset</button>
        </div>
      </section>}
      {error && <div className="flash error" role="alert"><span>{error}</span>
        <button className="text-button" onClick={() => setError("")}>Dismiss</button></div>}
      {notice?.screen === screen && <div className="flash notice" role="status"><span>{notice.text}</span>
        <button className="text-button" onClick={() => setNotice(null)}>Dismiss</button></div>}
      {screen === "Lobby" && <>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow"><span className="live-dot" /> Solo turbo market</p>
            <h1>Trade before<br />the rot<span>.</span></h1>
            <p>Buy Rots on Sunday. Visit neighboring islands for better prices. Sell before the next Sunday takes what’s left.</p>
            <div className="hero-actions">
              <button className="primary hero-button" onClick={(event) => {
                if (!guideDismissed && (!address || final)) showGuide(event.currentTarget);
                else void play();
              }} disabled={Boolean(setup)}>
                {setup ? (setup.error ? "Setup paused" : "Setting up…") : address && !final ? "Resume week" : "Play now"}
              </button>
              {!setup && <button className="secondary" onClick={() => setAbandonAction("reset")}>Reset</button>}
            </div>
            <p className="hero-status">Instant session · No wallet needed</p>
          </div>
          <div className="hero-image" role="img" aria-label="Sunset over a cluster of rocky islands" />
        </section>
        <section className="lobby-facts" aria-label="Turbo week rules">
          <Stat label="Starting coins" value={number.format(START_COINS)} />
          <Stat label="House opponents" value="3 bots" />
          <Stat label="Market ticks" value={`${TRADING_TICKS} × ${TICK_MS / 1_000} sec`} />
          <Stat label="Sunday buy window" value={`${SUNDAY_BUY_SECONDS} sec`} />
        </section>
      </>}

      {screen === "My Island" && <>
        <section className="page-head">
          <div><p className="eyebrow">My Island</p><h1>{ISLANDS[0]}</h1>
            <p>Your home market. Prices appear as each half-day starts.</p></div>
          <div className="week-actions">
            <div className="stats">
              <Stat label="Coins" value={coins === undefined ? "—" : number.format(coins)} />
              <Stat label="Rots held" value={final ? 0 : player ? held : "—"} />
              <Countdown week={week} final={final} />
            </div>
            <button className="secondary" onClick={() => setAbandonAction("restart")}>Restart week</button>
          </div>
        </section>
        <div className="market-layout">
          <section className="panel home-chart">
            <div className="section-title">
              <div><p className="eyebrow">{revealed ? "Public price track" : "Private price track"}</p>
                <h2>{revealed ? "Week complete" : phase === "lobby" ? "Waiting for Sunday" : tickLabel(visibleTick)}</h2></div>
              <span className="pill">{revealed ? "Revealed" : "🔒 Private"}</span>
            </div>
            <Chart prices={home?.prices.slice(0, visibleTick) ?? []} />
            <div className="chart-footer"><span>{visibleTick} / {TRADING_TICKS} ticks</span>
              <strong>{homeLive === undefined ? "Coins per Rot" : `${homeLive} coins / Rot`}</strong></div>
          </section>
          <section className="panel trade-panel">
            <Art index={0} />
            <div className="trade-copy">
              <p className="eyebrow">{phase === "sunday" || readyToOpen ? "Sunday buy-in" : "Home market"}</p>
              {week && (phase === "sunday" || readyToOpen) && <BuyWindow week={week} />}
              {(buying || readyToOpen) && home ? <>
                <h2>{home.sundayPrice} <small>coins / Rot</small></h2>
                <form onSubmit={(event) => { event.preventDefault(); buy(buyQty); }}>
                  <label htmlFor="sunday-quantity">Quantity (max {BUY_CAP})</label>
                  <div className="trade-row sunday-buy-row">
                    <input id="sunday-quantity" type="number" min="1" max={BUY_CAP} value={buyQty}
                      onChange={(event) => setBuyQty(Math.min(BUY_CAP, Math.max(0, Math.floor(Number(event.target.value)))))} />
                    {buyQty !== BUY_CAP && <button type="submit" className="secondary" disabled={!canBuy(buyQty)}>Buy {buyQty}</button>}
                    <button ref={buyButton} type={buyQty === BUY_CAP ? "submit" : "button"} className="primary sunday-buy" disabled={!canBuy(BUY_CAP)}
                      onClick={buyQty === BUY_CAP ? undefined : () => buy(BUY_CAP)}>
                      Buy {BUY_CAP}
                    </button>
                  </div>
                </form>
                <p className="muted">{number.format(buyQty * home.sundayPrice)} coins total · One buy per week</p>
              </> : trading ? <>
                <h2>{homeLive ?? "—"} <small>coins / Rot</small></h2>
                {held > 0 ? <Offer index={0} rots={held} busy={busy || !!sale} tick={visibleTick} price={homeLive}
                  onSell={(index, qty) => void act("sell", index, qty)} />
                  : !skippedBuy && <p className="muted">You have no Rots to sell.</p>}
                <button className="secondary" onClick={() => setScreen("Archipelago")}>Explore islands</button>
              </> : <>
                <h2>{revealed ? "Market closed" : phase === "sunday" ? (player?.bought || purchased ? "Buy-in complete" : "Sunday market") : "Market opening"}</h2>
                <p className="muted">{revealed ? "See the public price tracks and final balances."
                  : phase === "sunday" ? "Trading starts on Monday." : "Waiting for the devnet randomness that sets Sunday prices."}</p>
                {revealed && <button className="secondary" onClick={() => setScreen("Reveal")}>View reveal</button>}
              </>}
              {readyToOpen && (sundayError
                ? <><p className="muted" role="alert">{sundayError}</p>
                  <button className="secondary" onClick={() => setSundayError("")}>Retry opening Sunday</button></>
                : <p className="muted" role="status">Opening the Sunday buy window…</p>)}
              {phase === "sunday" && week?.tickMs === TICK_MS &&
                <button className="secondary" disabled={busy} onClick={() => void actSunday("doneBuying")}>Done buying</button>}
              {skippedBuy && <p className="buy-skipped" role="status">You skipped the Sunday buy, so there's nothing to sell this week. Start a new week from the Lobby.</p>}
            </div>
          </section>
        </div>
      </>}

      {screen === "Archipelago" && <>
        <section className="page-head">
          <div><p className="eyebrow">The island market</p><h1>Archipelago</h1>
            <p>You can only buy on Sunday at your island. Visit other islands to sell at their price.</p>
            <p>Tip an island owner to see their live price and sell there.</p></div>
          <div className="week-actions">
            <div className="stats"><Stat label="Passes used" value={`${player?.passesUsed ?? (final ? "—" : 0)} / ${PASS_CAP}`} />
              <Countdown week={week} final={final} /></div>
            <button className="secondary" onClick={() => setAbandonAction("restart")}>Restart week</button>
          </div>
        </section>
        <section className="island-grid" aria-label="Four islands">
          {ISLANDS.map((name, index) => {
            const island = islands[index];
            const hasPass = Boolean((week?.gatesOpen[index] ?? 0) & 1);
            const visiting = activePending.includes(index);
            const showTrack = Boolean(island && (index === 0 || hasPass || revealed));
            const canVisit = open && !hasPass && player && player.passesUsed + activePending.length < PASS_CAP
              && player.coins.toNumber() >= TIP && !visiting;
            const live = showTrack && island && (trading ? island.prices[visibleTick - 1]
              : phase === "sunday" ? island.sundayPrice : revealed ? island.prices[TRADING_TICKS - 1] : undefined);
            return <article className="panel island-card" key={name}>
              <Art index={index} />
              <div className="island-body">
                <p className="eyebrow">{index === 0 ? "Your island" : "House island"}</p>
                <h2>{name}</h2>
                <div className="island-status">
                  {showTrack ? <><span>{revealed ? "Final price" : trading ? "Live price" : phase === "sunday" ? "Sunday price" : "Private price"}</span>
                    <strong>{typeof live === "number" ? `${live} coins / Rot` : "—"}</strong></>
                    : <strong>{index === 0 ? "Loading private price…" : "Gates closed 🔒"}</strong>}
                </div>
                {index === 0 ? <button className="secondary" onClick={() => setScreen("My Island")}>My Island</button>
                  : revealed ? <button className="secondary" onClick={() => setScreen("Reveal")}>View chart</button>
                  : hasPass || visiting ? <Offer index={index} rots={held} pending={visiting}
                    busy={busy || !!sale || !trading || !showTrack} tick={hasPass ? visibleTick : undefined}
                    price={trading && typeof live === "number" ? live : undefined}
                    onSell={(place, qty) => void act("sell", place, qty)} />
                  : <button className="secondary" disabled={!canVisit || busy} aria-busy={requesting === index}
                    onClick={() => void act("requestGate", index)}>
                    {requesting === index ? "Requesting…" : `Visit (tip ${TIP})`}
                  </button>}
              </div>
            </article>;
          })}
        </section>
      </>}

      {screen === "Reveal" && <>
        <section className="page-head">
          <div><p className="eyebrow">Rot Sunday</p><h1>The Reveal</h1><p>The market has closed. Every island’s prices and balances are public.</p></div>
          <button className="primary" disabled={!final || Boolean(setup)} onClick={() => void play()}>
            {setup ? "Setting up…" : "Play again"}
          </button>
        </section>
        <div className="reveal-layout">
          <Reveal receipt={receipt} week={week} islands={islands} settled={final}
            retry={() => { setError(""); setSettleAttempt((value) => value + 1); }} />
        </div>
      </>}
    </main>
    <footer><span>Rotfolio</span><span>Play coins · Solana devnet</span></footer>
    <HowToPlay open={guideOpen} onDismiss={dismissGuide} />
    {abandonAction && <AbandonDialog action={abandonAction} cancel={() => setAbandonAction(null)}
      confirm={() => abandon(abandonAction === "restart")} />}
  </div>;
}
