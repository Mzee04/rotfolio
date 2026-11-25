import { TIP, type Player } from "./chain";

export function confirmedSalePrice(before: Player, after: Player, quantity: number) {
  const newPasses = after.passesUsed - before.passesUsed;
  if (before.rots - after.rots !== quantity || newPasses < 0 || quantity <= 0) return undefined;
  // A pass granted during the sale debits a tip, so add it back to isolate the sale credit.
  const price = (after.coins.sub(before.coins).toNumber() + newPasses * TIP) / quantity;
  return Number.isSafeInteger(price) && price > 0 ? price : undefined;
}

export function clampSellDraft(draft: string | null, rots: number) {
  if (draft === null || draft === "") return draft;
  if (rots === 0) return "0";
  const quantity = Math.floor(Number(draft));
  return String(Math.min(rots, Math.max(1, quantity || 1)));
}
