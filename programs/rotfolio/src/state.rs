use anchor_lang::prelude::*;

use crate::pricing::{ISLAND_COUNT, TRADING_TICKS};

pub const WEEK_SEED: &[u8] = b"week";
pub const ISLAND_SEED: &[u8] = b"island";
pub const PLAYER_SEED: &[u8] = b"player";
pub const GATE_SEED: &[u8] = b"gate";

pub const START_COINS: u64 = 12_000;
pub const BUY_CAP: u16 = 100;
pub const GATE_TIP: u64 = 20;
pub const MAX_PASSES: u8 = 3;
pub const MAX_MEMBERS: usize = 4;
pub const SUNDAY_SECONDS: i64 = 30;
pub const TURBO_TICK_MS: u32 = 10_000;
pub const LEGACY_SUNDAY_SECONDS: i64 = 10;
pub const ROT_TICK: u8 = 13;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum Phase {
    Lobby,
    Sunday,
    Trading,
    Rotted,
    Settled,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace)]
pub struct Score {
    pub owner: Pubkey,
    pub coins: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Week {
    pub id: u64,
    pub creator: Pubkey,
    pub phase: Phase,
    pub tick: u8,
    pub tick_ms: u32,
    pub start_ts: i64,
    pub sunday_end_ts: i64,
    pub next_tick_ts: i64,
    pub islands: [Pubkey; ISLAND_COUNT],
    pub owners: [Pubkey; ISLAND_COUNT],
    pub players: [Pubkey; ISLAND_COUNT],
    pub gates_open: [u8; ISLAND_COUNT],
    pub vrf_requested: bool,
    pub vrf_requested_ts: i64,
    pub seeded: bool,
    pub crank_task_id: u64,
    pub scoreboard: [Score; ISLAND_COUNT],
    pub bump: u8,
}

impl Week {
    pub fn open_sunday(&mut self, now: i64) {
        self.phase = Phase::Sunday;
        self.start_ts = now;
        let duration = if self.tick_ms == TURBO_TICK_MS {
            SUNDAY_SECONDS
        } else {
            LEGACY_SUNDAY_SECONDS
        };
        self.sunday_end_ts = now + duration;
        self.next_tick_ts = if self.tick_ms == TURBO_TICK_MS {
            (now + self.tick_seconds()).min(self.sunday_end_ts)
        } else {
            self.sunday_end_ts
        };
    }

    pub fn finish_buying(&mut self, now: i64) {
        self.sunday_end_ts = self.sunday_end_ts.min(now);
    }

    pub fn full(&self) -> bool {
        self.owners.iter().all(|owner| *owner != Pubkey::default())
    }

    pub fn market_open(&self) -> bool {
        self.phase == Phase::Sunday || self.phase == Phase::Trading
    }

    pub fn tick_at(&self, now: i64) -> u8 {
        if self.phase == Phase::Lobby || now < self.sunday_end_ts {
            return 0;
        }
        let ticks = 1 + (now - self.sunday_end_ts) / self.tick_seconds();
        ticks.min(i64::from(ROT_TICK)) as u8
    }

    pub fn tick_seconds(&self) -> i64 {
        i64::from(self.tick_ms) / 1_000
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded_week(tick_ms: u32) -> Week {
        Week {
            id: 0,
            creator: Pubkey::default(),
            phase: Phase::Lobby,
            tick: 0,
            tick_ms,
            start_ts: 0,
            sunday_end_ts: 0,
            next_tick_ts: 0,
            islands: [Pubkey::default(); ISLAND_COUNT],
            owners: [Pubkey::default(); ISLAND_COUNT],
            players: [Pubkey::default(); ISLAND_COUNT],
            gates_open: [0; ISLAND_COUNT],
            vrf_requested: true,
            vrf_requested_ts: 100,
            seeded: true,
            crank_task_id: 0,
            scoreboard: [Score { owner: Pubkey::default(), coins: 0 }; ISLAND_COUNT],
            bump: 0,
        }
    }

    #[test]
    fn turbo_calendar_waits_for_sunday_and_runs_twelve_ten_second_ticks() {
        let mut week = seeded_week(TURBO_TICK_MS);
        let opened_at = 500;
        assert_eq!(week.tick_at(opened_at), 0);

        week.open_sunday(opened_at);
        assert_eq!(week.next_tick_ts, opened_at + 10);
        let monday = opened_at + 30;
        assert_eq!(week.sunday_end_ts, monday);
        assert_eq!(week.tick_at(monday - 1), 0);
        for tick in 1..=12 {
            let first_second = monday + i64::from(tick - 1) * 10;
            assert_eq!(week.tick_at(first_second), tick);
            assert_eq!(week.tick_at(first_second + 9), tick);
        }
        assert_eq!(week.tick_at(monday + 120), ROT_TICK);
    }

    #[test]
    fn finishing_sunday_early_restarts_the_calendar_from_monday() {
        let mut week = seeded_week(TURBO_TICK_MS);
        week.open_sunday(500);
        week.finish_buying(504);
        assert_eq!(week.tick_at(504), 1);
        assert_eq!(week.tick_at(513), 1);
        assert_eq!(week.tick_at(514), 2);
        assert_eq!(week.tick_at(624), ROT_TICK);
        week.finish_buying(640);
        assert_eq!(week.sunday_end_ts, 504);
    }

    #[test]
    fn existing_week_intervals_keep_their_original_sunday() {
        for tick_ms in [5_000, 25_000] {
            let mut week = seeded_week(tick_ms);
            week.open_sunday(500);
            assert_eq!(week.sunday_end_ts, 510);
            assert_eq!(week.next_tick_ts, 510);
            assert_eq!(week.tick_at(510 + 12 * week.tick_seconds()), ROT_TICK);
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Island {
    pub week: Pubkey,
    pub idx: u8,
    pub owner: Pubkey,
    pub pattern: u8,
    pub sunday_price: u16,
    pub prices: [u16; TRADING_TICKS],
    pub gate_requested: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub week: Pubkey,
    pub owner: Pubkey,
    pub island_idx: u8,
    pub coins: u64,
    pub rots: u16,
    pub bought: bool,
    pub passes_used: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct GatePass {
    pub island: Pubkey,
    pub visitor: Pubkey,
    pub granted_tick: u8,
    pub expires_tick: u8,
    pub tip_paid: u64,
    pub bump: u8,
}

impl GatePass {
    pub fn live(&self, tick: u8) -> bool {
        self.granted_tick <= tick && tick < self.expires_tick
    }
}
