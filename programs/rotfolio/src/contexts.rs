use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    anchor::{delegate, vrf, vrf_callback},
    consts::{EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, MAGIC_PROGRAM_ID, PERMISSION_PROGRAM_ID},
    vrf,
};

use crate::{errors::MarketError, state::*, VRF_PROGRAM_IDENTITY};

#[derive(Accounts)]
#[instruction(week_id: u64)]
pub struct CreateWeek<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(init, payer = creator, space = 8 + Week::INIT_SPACE,
        seeds = [WEEK_SEED, &week_id.to_le_bytes()], bump)]
    pub week: Box<Account<'info, Week>>,
    #[account(init, payer = creator, space = 8 + Island::INIT_SPACE,
        seeds = [ISLAND_SEED, week.key().as_ref(), &[0]], bump)]
    pub island0: Box<Account<'info, Island>>,
    #[account(init, payer = creator, space = 8 + Island::INIT_SPACE,
        seeds = [ISLAND_SEED, week.key().as_ref(), &[1]], bump)]
    pub island1: Box<Account<'info, Island>>,
    #[account(init, payer = creator, space = 8 + Island::INIT_SPACE,
        seeds = [ISLAND_SEED, week.key().as_ref(), &[2]], bump)]
    pub island2: Box<Account<'info, Island>>,
    #[account(init, payer = creator, space = 8 + Island::INIT_SPACE,
        seeds = [ISLAND_SEED, week.key().as_ref(), &[3]], bump)]
    pub island3: Box<Account<'info, Island>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(week_id: u64)]
pub struct Join<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(mut, has_one = creator @ MarketError::NotCreator,
        seeds = [WEEK_SEED, &week_id.to_le_bytes()], bump = week.bump)]
    pub week: Box<Account<'info, Week>>,
    #[account(mut, has_one = week @ MarketError::AccountMismatch)]
    pub island: Account<'info, Island>,
    #[account(init, payer = creator, space = 8 + Player::INIT_SPACE,
        seeds = [PLAYER_SEED, week.key().as_ref(), owner.key().as_ref()], bump)]
    pub player: Account<'info, Player>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(week_id: u64)]
pub struct DelegateWeek<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: PDA checked here, and base-layer data verified before delegation.
    #[account(mut, del, seeds = [WEEK_SEED, &week_id.to_le_bytes()], bump)]
    pub week: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(week_id: u64, island_idx: u8)]
pub struct DelegateIsland<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(has_one = creator @ MarketError::NotCreator,
        seeds = [WEEK_SEED, &week_id.to_le_bytes()], bump = week.bump)]
    pub week: Box<Account<'info, Week>>,
    /// CHECK: PDA checked here, and the week must list it before delegation.
    #[account(mut, del, seeds = [ISLAND_SEED, week.key().as_ref(), &[island_idx]], bump)]
    pub island: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
#[instruction(week_id: u64, owner: Pubkey)]
pub struct DelegatePlayer<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(has_one = creator @ MarketError::NotCreator,
        seeds = [WEEK_SEED, &week_id.to_le_bytes()], bump = week.bump)]
    pub week: Box<Account<'info, Week>>,
    /// CHECK: PDA checked here, and the week must list it before delegation.
    #[account(mut, del, seeds = [PLAYER_SEED, week.key().as_ref(), owner.as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RollupPrograms<'info> {
    /// CHECK: MagicBlock permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: MagicBlock vault collecting ephemeral account rent.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: MagicBlock runtime program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct InitPermissions<'info> {
    pub creator: Signer<'info>,
    #[account(has_one = creator @ MarketError::NotCreator)]
    pub week: Box<Account<'info, Week>>,
    pub rollup: RollupPrograms<'info>,
}

#[vrf]
#[derive(Accounts)]
pub struct StartWeek<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut, has_one = creator @ MarketError::NotCreator)]
    pub week: Box<Account<'info, Week>>,
    pub rollup: RollupPrograms<'info>,
    /// CHECK: Only the devnet TEE's delegated queue is accepted.
    #[account(mut, address = vrf::consts::DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

impl StartWeek<'_> {
    pub(crate) fn request_randomness(&self, ix: &vrf::compat::Instruction) -> Result<()> {
        self.invoke_signed_vrf(self.creator.as_ref(), ix)?;
        Ok(())
    }
}

#[vrf_callback]
#[derive(Accounts)]
pub struct SeedIslands<'info> {
    #[account(address = VRF_PROGRAM_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub week: Box<Account<'info, Week>>,
    #[account(mut)]
    pub island0: Account<'info, Island>,
    #[account(mut)]
    pub island1: Account<'info, Island>,
    #[account(mut)]
    pub island2: Account<'info, Island>,
    #[account(mut)]
    pub island3: Account<'info, Island>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    pub signer: Signer<'info>,
    pub week: Box<Account<'info, Week>>,
    #[account(mut, has_one = week @ MarketError::AccountMismatch,
        constraint = player.owner == signer.key() @ MarketError::AccountMismatch)]
    pub player: Account<'info, Player>,
    #[account(has_one = week @ MarketError::AccountMismatch)]
    pub island: Account<'info, Island>,
}

#[derive(Accounts)]
pub struct OpenSunday<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub signer: Signer<'info>,
    #[account(mut, has_one = creator @ MarketError::NotCreator,
        constraint = week.owners[0] == signer.key() @ MarketError::NotHumanPlayer)]
    pub week: Box<Account<'info, Week>>,
    pub rollup: RollupPrograms<'info>,
}

#[derive(Accounts)]
pub struct DoneBuying<'info> {
    pub signer: Signer<'info>,
    #[account(mut, constraint = week.owners[0] == signer.key() @ MarketError::NotHumanPlayer)]
    pub week: Box<Account<'info, Week>>,
    pub rollup: RollupPrograms<'info>,
}

#[derive(Accounts)]
pub struct RequestGate<'info> {
    pub signer: Signer<'info>,
    pub week: Box<Account<'info, Week>>,
    #[account(has_one = week @ MarketError::AccountMismatch,
        constraint = player.owner == signer.key() @ MarketError::AccountMismatch)]
    pub player: Account<'info, Player>,
    #[account(mut, has_one = week @ MarketError::AccountMismatch)]
    pub island: Account<'info, Island>,
}

#[derive(Accounts)]
pub struct ManageGate<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub week: Box<Account<'info, Week>>,
    #[account(mut, has_one = week @ MarketError::AccountMismatch,
        has_one = owner @ MarketError::NotIslandOwner)]
    pub island: Account<'info, Island>,
    #[account(mut, has_one = week @ MarketError::AccountMismatch,
        has_one = owner @ MarketError::NotIslandOwner)]
    pub owner_player: Account<'info, Player>,
    #[account(mut, has_one = week @ MarketError::AccountMismatch)]
    pub visitor_player: Account<'info, Player>,
    /// CHECK: Address checked against the island's permission PDA by the handler.
    #[account(mut)]
    pub island_permission: UncheckedAccount<'info>,
    /// CHECK: Gate PDA checked by the handler, which may allocate it.
    #[account(mut)]
    pub gate_pass: UncheckedAccount<'info>,
    /// CHECK: Address checked against the gate's permission PDA by the handler.
    #[account(mut)]
    pub gate_permission: UncheckedAccount<'info>,
    pub rollup: RollupPrograms<'info>,
}

#[derive(Accounts)]
pub struct Sell<'info> {
    pub signer: Signer<'info>,
    pub week: Box<Account<'info, Week>>,
    #[account(mut, has_one = week @ MarketError::AccountMismatch,
        constraint = player.owner == signer.key() @ MarketError::AccountMismatch)]
    pub player: Account<'info, Player>,
    #[account(has_one = week @ MarketError::AccountMismatch)]
    pub island: Account<'info, Island>,
    /// CHECK: Visitors must supply their canonical GatePass. The owner's sale ignores this account.
    pub gate_pass: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Tick<'info> {
    #[account(mut)]
    pub week: Box<Account<'info, Week>>,
    pub rollup: RollupPrograms<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub week: Box<Account<'info, Week>>,
    /// CHECK: MagicBlock context for commit and undelegate.
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: MagicBlock runtime program.
    #[account(address = MAGIC_PROGRAM_ID)]
    pub magic_program: UncheckedAccount<'info>,
}
