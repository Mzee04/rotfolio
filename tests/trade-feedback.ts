import assert from "node:assert/strict";
import { BN } from "@coral-xyz/anchor";
import type { Player } from "../app/src/chain";
import { clampSellDraft, confirmedSalePrice } from "../app/src/trade-feedback";

function player(coins: number, rots: number, passesUsed = 0): Player {
  return { coins: new BN(coins), rots, passesUsed, bought: true };
}

describe("Trade feedback", () => {
  it("reports the credited unit price when the displayed quote rolls over", () => {
    const before = player(2_000, 100);
    const displayedPrice = 120;
    const executionPrice = 175;
    const after = player(2_000 + 17 * executionPrice, 83);
    const price = confirmedSalePrice(before, after, 17);
    assert.equal(price, executionPrice);
    assert.notEqual(price, displayedPrice);
  });

  it("adds back tips for visits granted during the sale", () => {
    const before = player(2_000, 100, 1);
    const after = player(2_000 + 17 * 175 - 40, 83, 3);
    assert.equal(confirmedSalePrice(before, after, 17), 175);
  });

  it("omits a price when the snapshots do not isolate the sale", () => {
    const before = player(2_000, 100);
    assert.equal(confirmedSalePrice(before, before, 17), undefined);
    assert.equal(confirmedSalePrice(before, player(5_200, 80), 17), undefined);
    assert.equal(confirmedSalePrice(before, player(5_000, 83), 17), undefined);
  });

  it("clamps the previous quantity to the remaining Rots", () => {
    assert.equal(clampSellDraft("60", 40), "40");
    assert.equal(clampSellDraft("17", 83), "17");
    assert.equal(clampSellDraft("40", 0), "0");
    assert.equal(clampSellDraft("", 40), "");
    assert.equal(clampSellDraft(null, 40), null);
  });

  it("clamps an over-held entry to the amount available to sell", () => {
    assert.equal(clampSellDraft("500", 83), "83");
    assert.equal(clampSellDraft("999", 40), "40");
  });

  it("keeps entered quantities at or above one while Rots are held", () => {
    assert.equal(clampSellDraft("0", 83), "1");
    assert.equal(clampSellDraft("-5", 83), "1");
    assert.equal(clampSellDraft("8.5", 83), "8");
  });
});
