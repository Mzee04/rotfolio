import { useEffect, useRef } from "react";
import { BUY_CAP, PASS_CAP, START_COINS, SUNDAY_BUY_SECONDS, TICK_MS, TIP } from "./chain";

export function HowToPlay({ open, onDismiss }: { open: boolean; onDismiss: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const modal = dialog.current;
    if (open && modal && !modal.open) {
      modal.showModal();
      closeButton.current?.focus();
    }
  }, [open]);

  function dismiss() {
    dialog.current?.close();
    onDismiss();
  }

  return <dialog id="how-to-play" ref={dialog} className="guide-dialog" aria-labelledby="guide-title"
    onCancel={(event) => { event.preventDefault(); dismiss(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
      if (event.clientX < left || event.clientX > right || event.clientY < top || event.clientY > bottom) dismiss();
    }}
    onKeyDown={(event) => {
      // The close button is the dialog's only tab stop.
      if (event.key === "Tab") {
        event.preventDefault();
        closeButton.current?.focus();
      }
    }}>
    <div className="guide-content">
      <div className="guide-heading">
        <h2 id="guide-title">How to play</h2>
        <button type="button" className="guide-close" ref={closeButton} aria-label="Close how to play" onClick={dismiss}>×</button>
      </div>
      <ol className="guide-steps">
        <li>
          <h3>Sunday buy</h3>
          <p>You start with {START_COINS.toLocaleString("en-US")} play coins. Once the buy card appears, you have {SUNDAY_BUY_SECONDS} seconds to buy up to {BUY_CAP} Rots once at your island’s Sunday price. If you skip it, you have nothing to sell all week.</p>
        </li>
        <li>
          <h3>AM and PM trading</h3>
          <p>Monday through Saturday each have two price ticks. In turbo, a new tick comes every {TICK_MS / 1_000} seconds. Sell some or all of your Rots on your home island at any point during trading.</p>
        </li>
        <li>
          <h3>Island gates</h3>
          <p>On Archipelago, request a visit to a house island. When the pass is granted, you pay a {TIP}-coin tip, see its private live price, and can sell there. You have {PASS_CAP} passes a week. Other islands are sell-only. Sunday at your island is the only time you can buy.</p>
        </li>
        <li>
          <h3>Rot Sunday</h3>
          <p>At tick 13, unsold Rots expire, all prices and balances go public, and players are ranked by final coins. Any Rots you still hold are worth 0.</p>
        </li>
      </ol>
      <p className="guide-tip"><strong>Tip:</strong> buy all 100 on Sunday, then use your passes to find the island whose price spikes.</p>
    </div>
  </dialog>;
}
