use anchor_lang::{
    prelude::*,
    solana_program::instruction::{AccountMeta, Instruction},
};
use ephemeral_rollups_sdk::{
    anchor::ephemeral,
    consts::DELEGATION_PROGRAM_ID,
    cpi::DelegateConfig,
    ephem::MagicIntentBundleBuilder,
    vrf::{
        self,
        instructions::{create_request_randomness_ix_const, RequestRandomnessParams},
        types::SerializableAccountMeta,
    },
};

#[allow(deprecated)]
use ephemeral_rollups_sdk::crank::{ScheduleCrankCpi, ScheduleTaskArgs};

mod contexts;
mod errors;
mod market;
pub mod pricing;
mod state;

pub use contexts::*;
use errors::MarketError;
use market::{
    fund_reserve, read_account, GateAccounts, WeekAccounts, ISLAND_RESERVE, PLAYER_RESERVE,
};
use pricing::ISLAND_COUNT;
use state::*;

declare_id!("9czd3zpazBa4fLBcNihWyKEgeKkZ4K8xEdoMWeY5Zj9b");

const TEE_VALIDATOR: Pubkey = Pubkey::from_str_const("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const PROGRAM_IDENTITY: Pubkey = vrf::consts::program_identity_pubkey(&ID);
pub const VRF_PROGRAM_IDENTITY: Pubkey =
    Pubkey::new_from_array(vrf::consts::scoped_vrf_identity_const(&ID).0);
const VRF_RETRY_SECONDS: i64 = 20;
const CRANK_ITERATIONS: i64 = 27;

#[ephemeral]
#[program]
pub mod rotfolio {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    pub fn create_week(ctx: Context<CreateWeek>, week_id: u64, tick_ms: u32) -> Result<()> {
        require!(
            matches!(tick_ms, 5_000 | TURBO_TICK_MS | 25_000),
            MarketError::BadTickInterval
        );
        let a = ctx.accounts;
        let week_key = a.week.key();
        let islands = [
            (&mut a.island0, ctx.bumps.island0),
            (&mut a.island1, ctx.bumps.island1),
            (&mut a.island2, ctx.bumps.island2),
            (&mut a.island3, ctx.bumps.island3),
        ];
        let mut island_keys = [Pubkey::default(); ISLAND_COUNT];
        for (index, (island, bump)) in islands.into_iter().enumerate() {
            fund_reserve(
                &a.creator,
                island.to_account_info(),
                &a.system_program,
                ISLAND_RESERVE,
            )?;
            island.week = week_key;
            island.idx = index as u8;
            island.bump = bump;
            island_keys[index] = island.key();
        }
        a.week.set_inner(Week {
            id: week_id,
            creator: a.creator.key(),
            phase: Phase::Lobby,
            tick: 0,
            tick_ms,
            start_ts: 0,
            sunday_end_ts: 0,
            next_tick_ts: 0,
            islands: island_keys,
            owners: [Pubkey::default(); ISLAND_COUNT],
            players: [Pubkey::default(); ISLAND_COUNT],
            gates_open: [0; ISLAND_COUNT],
            vrf_requested: false,
            vrf_requested_ts: 0,
            seeded: false,
            crank_task_id: 0,
            scoreboard: [Score {
                owner: Pubkey::default(),
                coins: 0,
            }; ISLAND_COUNT],
            bump: ctx.bumps.week,
        });
        Ok(())
    }

    pub fn join(ctx: Context<Join>, _week_id: u64) -> Result<()> {
        let a = ctx.accounts;
        let owner = a.owner.key();
        require!(a.week.phase == Phase::Lobby, MarketError::WrongPhase);
        require!(!a.week.owners.contains(&owner), MarketError::AlreadyJoined);
        let index = a
            .week
            .owners
            .iter()
            .position(|key| *key == Pubkey::default())
            .ok_or(MarketError::WeekFull)?;
        require_keys_eq!(
            a.island.key(),
            a.week.islands[index],
            MarketError::AccountMismatch
        );
        fund_reserve(
            &a.creator,
            a.player.to_account_info(),
            &a.system_program,
            PLAYER_RESERVE,
        )?;
        a.player.set_inner(Player {
            week: a.week.key(),
            owner,
            island_idx: index as u8,
            coins: START_COINS,
            rots: 0,
            bought: false,
            passes_used: 0,
            bump: ctx.bumps.player,
        });
        a.island.owner = owner;
        a.week.owners[index] = owner;
        a.week.players[index] = a.player.key();
        Ok(())
    }

    pub fn delegate_island(
        ctx: Context<DelegateIsland>,
        _week_id: u64,
        island_idx: u8,
    ) -> Result<()> {
        let a = ctx.accounts;
        require_ready_to_delegate(&a.week)?;
        require!(
            a.week.islands.get(usize::from(island_idx)) == Some(&a.island.key()),
            MarketError::AccountMismatch
        );
        a.delegate_island(
            &a.creator,
            &[ISLAND_SEED, a.week.key().as_ref(), &[island_idx]],
            tee_delegate_config(),
        )?;
        Ok(())
    }

    pub fn delegate_player(
        ctx: Context<DelegatePlayer>,
        _week_id: u64,
        owner: Pubkey,
    ) -> Result<()> {
        let a = ctx.accounts;
        require_ready_to_delegate(&a.week)?;
        require!(
            a.week.players.contains(&a.player.key()),
            MarketError::AccountMismatch
        );
        a.delegate_player(
            &a.creator,
            &[PLAYER_SEED, a.week.key().as_ref(), owner.as_ref()],
            tee_delegate_config(),
        )?;
        Ok(())
    }

    pub fn delegate_week(ctx: Context<DelegateWeek>, week_id: u64) -> Result<()> {
        let a = ctx.accounts;
        let week: Week = read_account(&a.week.to_account_info())?;
        require_keys_eq!(week.creator, a.creator.key(), MarketError::NotCreator);
        require_ready_to_delegate(&week)?;
        require!(
            ctx.remaining_accounts.len() == 2 * ISLAND_COUNT,
            MarketError::DelegateWeekLast
        );
        let expected = week.islands.iter().chain(&week.players);
        for (info, key) in ctx.remaining_accounts.iter().zip(expected) {
            require_keys_eq!(*info.key, *key, MarketError::AccountMismatch);
            require_keys_eq!(
                *info.owner,
                DELEGATION_PROGRAM_ID,
                MarketError::DelegateWeekLast
            );
        }
        a.delegate_week(
            &a.creator,
            &[WEEK_SEED, &week_id.to_le_bytes()],
            tee_delegate_config(),
        )?;
        Ok(())
    }

    pub fn init_permissions<'info>(ctx: Context<'info, InitPermissions<'info>>) -> Result<()> {
        let a = ctx.accounts;
        require_ready_to_delegate(&a.week)?;
        let accounts = WeekAccounts::parse(&a.week, ctx.remaining_accounts)?;
        market::init_week_permissions(&a.week, &accounts, &a.rollup)
    }

    pub fn start_week<'info>(ctx: Context<'info, StartWeek<'info>>) -> Result<()> {
        let a = ctx.accounts;
        require_ready_to_delegate(&a.week)?;
        let clock = Clock::get()?;
        require!(
            !a.week.seeded
                && (!a.week.vrf_requested
                    || clock.unix_timestamp >= a.week.vrf_requested_ts + VRF_RETRY_SECONDS),
            MarketError::VrfPending
        );

        let accounts = WeekAccounts::parse(&a.week, ctx.remaining_accounts)?;
        accounts.check_permissions(&a.week)?;
        let week_key = a.week.key();
        let callback_accounts = std::iter::once(week_key)
            .chain(a.week.islands)
            .map(|pubkey| SerializableAccountMeta {
                pubkey,
                is_signer: false,
                is_writable: true,
            })
            .collect();
        let mut caller_seed = week_key.to_bytes();
        for (byte, slot_byte) in caller_seed.iter_mut().zip(clock.slot.to_le_bytes()) {
            *byte ^= slot_byte;
        }
        let request = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: a.creator.key(),
                oracle_queue: a.oracle_queue.key(),
                callback_program_id: ID,
                callback_discriminator: crate::instruction::SeedIslands::DISCRIMINATOR.to_vec(),
                caller_seed,
                accounts_metas: Some(callback_accounts),
                callback_args: Some(a.week.id.to_le_bytes().to_vec()),
                ..Default::default()
            },
            PROGRAM_IDENTITY,
        );
        a.request_randomness(&request)?;
        a.week.vrf_requested = true;
        a.week.vrf_requested_ts = clock.unix_timestamp;

        if a.week.tick_ms != TURBO_TICK_MS && a.week.crank_task_id == 0 {
            a.week.crank_task_id = crank_id(week_key) as u64;
            schedule_tick(a.creator.as_ref(), &a.week, &a.rollup, ctx.remaining_accounts)?;
        }
        Ok(())
    }

    pub fn seed_islands(
        ctx: Context<SeedIslands>,
        randomness: [u8; 32],
        week_id: u64,
    ) -> Result<()> {
        let a = ctx.accounts;
        if a.week.id != week_id
            || a.week.phase != Phase::Lobby
            || !a.week.vrf_requested
            || a.week.seeded
        {
            return Ok(());
        }
        let generated = pricing::generate_week(randomness);
        let islands = [
            &mut a.island0,
            &mut a.island1,
            &mut a.island2,
            &mut a.island3,
        ];
        for (index, (island, prices)) in islands.into_iter().zip(generated).enumerate() {
            require_keys_eq!(
                island.key(),
                a.week.islands[index],
                MarketError::AccountMismatch
            );
            island.pattern = prices.pattern as u8;
            island.sunday_price = prices.sunday_price;
            island.prices = prices.prices;
        }
        a.week.seeded = true;
        if a.week.tick_ms != TURBO_TICK_MS {
            a.week.open_sunday(Clock::get()?.unix_timestamp);
        }
        Ok(())
    }

    pub fn open_sunday<'info>(ctx: Context<'info, OpenSunday<'info>>) -> Result<()> {
        let a = ctx.accounts;
        // Replaying the player's acknowledgement must never restart the timer.
        if a.week.phase == Phase::Sunday {
            return Ok(());
        }
        require!(
            a.week.phase == Phase::Lobby && a.week.seeded && a.week.tick_ms == TURBO_TICK_MS,
            MarketError::WrongPhase
        );
        let accounts = WeekAccounts::parse(&a.week, ctx.remaining_accounts)?;
        accounts.check_permissions(&a.week)?;
        a.week.open_sunday(Clock::get()?.unix_timestamp);
        a.week.crank_task_id = crank_id(a.week.key()) as u64;
        schedule_tick(a.creator.as_ref(), &a.week, &a.rollup, ctx.remaining_accounts)?;
        Ok(())
    }

    pub fn done_buying<'info>(ctx: Context<'info, DoneBuying<'info>>) -> Result<()> {
        let a = ctx.accounts;
        if a.week.phase == Phase::Trading {
            return Ok(());
        }
        require!(
            a.week.phase == Phase::Sunday && a.week.tick_ms == TURBO_TICK_MS,
            MarketError::WrongPhase
        );
        let now = Clock::get()?.unix_timestamp;
        let accounts = WeekAccounts::parse(&a.week, ctx.remaining_accounts)?;
        a.week.finish_buying(now);
        if a.week.tick_at(now) == ROT_TICK {
            accounts.check_permissions(&a.week)?;
        }
        market::tick_market(&mut a.week, &accounts, &a.rollup, now)?;
        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, qty: u16) -> Result<()> {
        let a = ctx.accounts;
        let now = Clock::get()?.unix_timestamp;
        require!(
            a.week.phase == Phase::Sunday && now < a.week.sunday_end_ts,
            MarketError::WrongPhase
        );
        require!(
            a.player.island_idx == a.island.idx,
            MarketError::AccountMismatch
        );
        market::buy(&mut a.player, qty, a.island.sunday_price)
    }

    pub fn request_gate(ctx: Context<RequestGate>, island_idx: u8) -> Result<()> {
        let a = ctx.accounts;
        require_market_open(&a.week)?;
        require!(a.player.passes_used < MAX_PASSES, MarketError::PassLimit);
        require!(a.island.idx == island_idx, MarketError::AccountMismatch);
        // There is one human seat. House bots trade on their own islands.
        require!(
            a.player.island_idx == 0 && island_idx > 0,
            MarketError::InvalidVisit
        );
        let gates = a.week.gates_open[usize::from(island_idx)];
        require!(
            gates.count_ones() < (MAX_MEMBERS - 1) as u32,
            MarketError::GateFull
        );
        require!(
            gates & 1 == 0 && !a.island.gate_requested,
            MarketError::GateAlreadyRequested
        );
        require!(a.player.coins >= GATE_TIP, MarketError::InsufficientCoins);
        a.island.gate_requested = true;
        Ok(())
    }

    pub fn open_gate(ctx: Context<ManageGate>, visitor: Pubkey) -> Result<()> {
        let a = ctx.accounts;
        check_gate_owner_action(a, visitor)?;
        let island_info = a.island.to_account_info();
        let gate = GateAccounts {
            island: &island_info,
            island_permission: a.island_permission.as_ref(),
            gate: a.gate_pass.as_ref(),
            gate_permission: a.gate_permission.as_ref(),
            rollup: &a.rollup,
        };
        gate.grant(
            &mut a.week,
            &mut a.island,
            &mut a.owner_player,
            &mut a.visitor_player,
        )
    }

    pub fn close_gate(ctx: Context<ManageGate>, visitor: Pubkey) -> Result<()> {
        let a = ctx.accounts;
        check_gate_owner_action(a, visitor)?;
        let gate = GateAccounts {
            island: a.island.as_ref(),
            island_permission: a.island_permission.as_ref(),
            gate: a.gate_pass.as_ref(),
            gate_permission: a.gate_permission.as_ref(),
            rollup: &a.rollup,
        };
        gate.revoke(&mut a.week, &a.island, &a.visitor_player)
    }

    pub fn sell(ctx: Context<Sell>, island_idx: u8, qty: u16) -> Result<()> {
        let a = ctx.accounts;
        require_market_open(&a.week)?;
        require!(
            a.week.phase == Phase::Trading && a.week.tick > 0,
            MarketError::WrongPhase
        );
        require!(a.island.idx == island_idx, MarketError::AccountMismatch);
        if a.player.island_idx != island_idx {
            let pass =
                market::checked_pass(a.gate_pass.as_ref(), &a.island.key(), &a.player.owner)?;
            require!(pass.live(a.week.tick), MarketError::NoGatePass);
        }
        let price = a.island.prices[usize::from(a.week.tick - 1)];
        market::sell(&mut a.player, qty, price)
    }

    pub fn tick<'info>(ctx: Context<'info, Tick<'info>>) -> Result<()> {
        let a = ctx.accounts;
        if !a.week.market_open() {
            return Ok(());
        }
        let now = Clock::get()?.unix_timestamp;
        if a.week.tick_ms == TURBO_TICK_MS && now < a.week.next_tick_ts {
            return Ok(());
        }
        let accounts = WeekAccounts::parse(&a.week, ctx.remaining_accounts)?;
        if a.week.tick_at(now) == ROT_TICK {
            accounts.check_permissions(&a.week)?;
        }
        market::tick_market(&mut a.week, &accounts, &a.rollup, now)
    }

    pub fn settle<'info>(ctx: Context<'info, Settle<'info>>) -> Result<()> {
        let a = ctx.accounts;
        require!(a.week.phase == Phase::Rotted, MarketError::WrongPhase);
        require!(
            ctx.remaining_accounts.len() == 2 * ISLAND_COUNT,
            MarketError::AccountMismatch
        );
        let keys = a.week.islands.iter().chain(&a.week.players);
        for (info, key) in ctx.remaining_accounts.iter().zip(keys) {
            require_keys_eq!(*info.key, *key, MarketError::AccountMismatch);
        }
        a.week.phase = Phase::Settled;
        a.week.exit(&ID)?;
        let commit = std::iter::once(a.week.to_account_info())
            .chain(ctx.remaining_accounts.iter().cloned())
            .collect::<Vec<_>>();
        MagicIntentBundleBuilder::new(
            a.payer.to_account_info(),
            a.magic_context.to_account_info(),
            a.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&commit)
        .build_and_invoke()?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

fn tee_delegate_config() -> DelegateConfig {
    DelegateConfig {
        validator: Some(TEE_VALIDATOR),
        ..Default::default()
    }
}

fn require_ready_to_delegate(week: &Week) -> Result<()> {
    require!(week.phase == Phase::Lobby, MarketError::WrongPhase);
    require!(week.full(), MarketError::WeekIncomplete);
    Ok(())
}

fn require_market_open(week: &Week) -> Result<()> {
    require!(
        week.market_open() && week.tick_at(Clock::get()?.unix_timestamp) < ROT_TICK,
        MarketError::WrongPhase
    );
    Ok(())
}

fn check_gate_owner_action(accounts: &ManageGate, visitor: Pubkey) -> Result<()> {
    require_market_open(&accounts.week)?;
    require_keys_eq!(
        accounts.visitor_player.owner,
        visitor,
        MarketError::AccountMismatch
    );
    require!(
        accounts.visitor_player.island_idx == 0 && accounts.island.idx > 0,
        MarketError::InvalidVisit
    );
    require!(
        accounts.owner_player.island_idx == accounts.island.idx,
        MarketError::AccountMismatch
    );
    Ok(())
}

#[allow(deprecated)]
fn schedule_tick<'info>(
    payer: &'info AccountInfo<'info>,
    week: &Account<'info, Week>,
    rollup: &'info RollupPrograms<'info>,
    remaining: &[AccountInfo<'info>],
) -> Result<()> {
    let tick_accounts = [
        week.to_account_info(),
        rollup.permission_program.to_account_info(),
        rollup.ephemeral_vault.to_account_info(),
        rollup.magic_program.to_account_info(),
    ]
    .into_iter()
    .chain(remaining.iter().cloned())
    .collect::<Vec<_>>();
    let metas = tick_accounts
        .iter()
        .map(|info| AccountMeta {
            pubkey: *info.key,
            is_signer: false,
            is_writable: info.is_writable,
        })
        .collect();
    let tick = Instruction {
        program_id: ID,
        accounts: metas,
        data: anchor_lang::InstructionData::data(&crate::instruction::Tick {}),
    };
    // Rot can update eleven separate permissions in one crank transaction.
    let compute_budget = Instruction {
        program_id: Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        accounts: Vec::new(),
        data: [&[2u8][..], &700_000u32.to_le_bytes()].concat(),
    };
    // Check the calendar each second so finishing Sunday early keeps the next
    // trading tick ten seconds away. The tick instruction enforces cadence.
    let (interval, iterations) = if week.tick_ms == TURBO_TICK_MS {
        let trading = i64::from(ROT_TICK - 1) * week.tick_seconds();
        (1_000, SUNDAY_SECONDS + trading + 20)
    } else {
        (i64::from(week.tick_ms), CRANK_ITERATIONS)
    };
    ScheduleCrankCpi {
        payer,
        magic_program: rollup.magic_program.as_ref(),
        instruction_accounts: &tick_accounts,
        args: ScheduleTaskArgs {
            task_id: week.crank_task_id as i64,
            execution_interval_millis: interval,
            iterations,
            instructions: vec![compute_budget, tick],
        },
    }
    .invoke()?;
    Ok(())
}

fn crank_id(week: Pubkey) -> i64 {
    (i64::from_le_bytes(week.as_ref()[..8].try_into().unwrap()) & i64::MAX).max(1)
}
