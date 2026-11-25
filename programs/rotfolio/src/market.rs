use anchor_lang::{prelude::*, system_program};
use ephemeral_rollups_sdk::{
    access_control::{
        instructions::{CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi},
        structs::{EphemeralMembersArgs, EphemeralPermission, Member},
    },
    consts::PERMISSION_PROGRAM_ID,
    ephemeral_accounts::{rent, EphemeralAccount},
};

use crate::{contexts::RollupPrograms, errors::MarketError, pricing::ISLAND_COUNT, state::*};

const PERMISSION_RENT: u64 = rent(EphemeralPermission::size_of(MAX_MEMBERS) as u32);
const GATE_SIZE: usize = 8 + GatePass::INIT_SPACE;
pub const ISLAND_RESERVE: u64 = PERMISSION_RENT + rent(GATE_SIZE as u32) + PERMISSION_RENT;
pub const PLAYER_RESERVE: u64 = PERMISSION_RENT;
const BOT_COUNT: usize = ISLAND_COUNT - 1;

pub fn fund_reserve<'info>(
    payer: &Signer<'info>,
    account: AccountInfo<'info>,
    system_program: &Program<'info, System>,
    lamports: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system_program.key(),
            system_program::Transfer {
                from: payer.to_account_info(),
                to: account,
            },
        ),
        lamports,
    )
}

pub fn read_account<T: AccountDeserialize + Owner>(info: &AccountInfo<'_>) -> Result<T> {
    require_keys_eq!(*info.owner, T::owner(), MarketError::AccountMismatch);
    T::try_deserialize(&mut &info.try_borrow_data()?[..])
}

pub fn write_account<T: AccountSerialize + Owner>(
    info: &AccountInfo<'_>,
    account: &T,
) -> Result<()> {
    require_keys_eq!(*info.owner, T::owner(), MarketError::AccountMismatch);
    account.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])
}

pub fn gate_address(island: &Pubkey, visitor: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[GATE_SEED, island.as_ref(), visitor.as_ref()], &crate::ID)
}

pub struct WeekAccounts<'a, 'info> {
    pub islands: &'a [AccountInfo<'info>],
    pub players: &'a [AccountInfo<'info>],
    pub island_permissions: &'a [AccountInfo<'info>],
    pub player_permissions: &'a [AccountInfo<'info>],
    pub gates: &'a [AccountInfo<'info>],
    pub gate_permissions: &'a [AccountInfo<'info>],
}

impl<'a, 'info> WeekAccounts<'a, 'info> {
    pub fn parse(week: &Week, remaining: &'a [AccountInfo<'info>]) -> Result<Self> {
        require!(
            remaining.len() == 4 * ISLAND_COUNT + 2 * BOT_COUNT,
            MarketError::AccountMismatch
        );
        let (islands, remaining) = remaining.split_at(ISLAND_COUNT);
        let (players, remaining) = remaining.split_at(ISLAND_COUNT);
        let (island_permissions, remaining) = remaining.split_at(ISLAND_COUNT);
        let (player_permissions, remaining) = remaining.split_at(ISLAND_COUNT);
        let (gates, gate_permissions) = remaining.split_at(BOT_COUNT);
        for index in 0..ISLAND_COUNT {
            require_keys_eq!(
                *islands[index].key,
                week.islands[index],
                MarketError::AccountMismatch
            );
            require_keys_eq!(
                *players[index].key,
                week.players[index],
                MarketError::AccountMismatch
            );
        }
        Ok(Self {
            islands,
            players,
            island_permissions,
            player_permissions,
            gates,
            gate_permissions,
        })
    }

    pub fn check_permissions(&self, week: &Week) -> Result<()> {
        for index in 0..ISLAND_COUNT {
            ensure_private(&self.islands[index], &self.island_permissions[index])?;
            ensure_private(&self.players[index], &self.player_permissions[index])?;
        }
        for (index, (gate, permission)) in self.gates.iter().zip(self.gate_permissions).enumerate()
        {
            let (address, _) = gate_address(&week.islands[index + 1], &week.owners[0]);
            require_keys_eq!(*gate.key, address, MarketError::AccountMismatch);
            ensure_private(gate, permission)?;
        }
        Ok(())
    }
}

fn check_permission_address(subject: &AccountInfo<'_>, permission: &AccountInfo<'_>) -> Result<()> {
    require_keys_eq!(
        *permission.key,
        EphemeralPermission::find_pda(subject.key).0,
        MarketError::AccountMismatch
    );
    Ok(())
}

fn ensure_private(subject: &AccountInfo<'_>, permission: &AccountInfo<'_>) -> Result<()> {
    check_permission_address(subject, permission)?;
    require_keys_eq!(
        *permission.owner,
        PERMISSION_PROGRAM_ID,
        MarketError::PermissionsMissing
    );
    let data = permission.try_borrow_data()?;
    let account = EphemeralPermission::from_bytes(&data)?;
    require!(
        account.private && account.permissioned_account == *subject.key,
        MarketError::PermissionsMissing
    );
    Ok(())
}

pub fn members(keys: impl IntoIterator<Item = Pubkey>) -> Vec<Member> {
    keys.into_iter()
        .map(|pubkey| Member { flags: 0, pubkey })
        .collect()
}

pub struct Permission<'a, 'info> {
    pub subject: &'a AccountInfo<'info>,
    pub account: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    pub rollup: &'a RollupPrograms<'info>,
}

impl Permission<'_, '_> {
    pub fn create(&self, members: Vec<Member>, signers: &[&[&[u8]]]) -> Result<()> {
        check_permission_address(self.subject, self.account)?;
        if self.account.owner == &PERMISSION_PROGRAM_ID {
            return ensure_private(self.subject, self.account);
        }
        CreateEphemeralPermissionCpi {
            payer: self.payer.clone(),
            permissioned_account: self.subject.clone(),
            permission: self.account.clone(),
            vault: self.rollup.ephemeral_vault.to_account_info(),
            magic_program: self.rollup.magic_program.to_account_info(),
            permission_program: self.rollup.permission_program.to_account_info(),
            args: EphemeralMembersArgs {
                is_private: true,
                members,
            },
        }
        .invoke_signed(signers)?;
        Ok(())
    }

    pub fn update(
        &self,
        is_private: bool,
        members: Vec<Member>,
        signers: &[&[&[u8]]],
    ) -> Result<()> {
        ensure_private(self.subject, self.account)?;
        UpdateEphemeralPermissionCpi {
            payer: self.payer.clone(),
            permissioned_account: self.subject.clone(),
            permission: self.account.clone(),
            vault: self.rollup.ephemeral_vault.to_account_info(),
            magic_program: self.rollup.magic_program.to_account_info(),
            permission_program: self.rollup.permission_program.to_account_info(),
            authority: self.subject.clone(),
            authority_is_signer: false,
            args: EphemeralMembersArgs {
                is_private,
                members,
            },
        }
        .invoke_signed(signers)?;
        Ok(())
    }
}

pub fn init_week_permissions<'info>(
    week: &Week,
    accounts: &WeekAccounts<'_, 'info>,
    rollup: &RollupPrograms<'info>,
) -> Result<()> {
    for index in 0..ISLAND_COUNT {
        let island_info = &accounts.islands[index];
        let player_info = &accounts.players[index];
        let island: Island = read_account(island_info)?;
        let player: Player = read_account(player_info)?;
        let owner = (index == 0).then_some(week.owners[index]);
        let island_seeds: &[&[u8]] = &[
            ISLAND_SEED,
            island.week.as_ref(),
            &[island.idx],
            &[island.bump],
        ];
        let player_seeds: &[&[u8]] = &[
            PLAYER_SEED,
            player.week.as_ref(),
            player.owner.as_ref(),
            &[player.bump],
        ];
        Permission {
            subject: island_info,
            account: &accounts.island_permissions[index],
            payer: island_info,
            rollup,
        }
        .create(members(owner), &[island_seeds])?;
        Permission {
            subject: player_info,
            account: &accounts.player_permissions[index],
            payer: player_info,
            rollup,
        }
        .create(members(owner), &[player_seeds])?;
        if index > 0 {
            GateAccounts {
                island: island_info,
                island_permission: &accounts.island_permissions[index],
                gate: &accounts.gates[index - 1],
                gate_permission: &accounts.gate_permissions[index - 1],
                rollup,
            }
            .reserve(&island, &week.owners[0])?;
        }
    }
    Ok(())
}

pub struct GateAccounts<'a, 'info> {
    pub island: &'a AccountInfo<'info>,
    pub island_permission: &'a AccountInfo<'info>,
    pub gate: &'a AccountInfo<'info>,
    pub gate_permission: &'a AccountInfo<'info>,
    pub rollup: &'a RollupPrograms<'info>,
}

impl<'info> GateAccounts<'_, 'info> {
    fn reserve(&self, island: &Island, visitor: &Pubkey) -> Result<()> {
        let (address, bump) = gate_address(self.island.key, visitor);
        require_keys_eq!(*self.gate.key, address, MarketError::AccountMismatch);
        let island_seeds: &[&[u8]] = &[
            ISLAND_SEED,
            island.week.as_ref(),
            &[island.idx],
            &[island.bump],
        ];
        let gate_seeds: &[&[u8]] = &[
            GATE_SEED,
            self.island.key.as_ref(),
            visitor.as_ref(),
            &[bump],
        ];
        if self.gate.data_is_empty() {
            // The TEE requires the crank's writable accounts to exist. This
            // zeroed slot has no discriminator and grants no trading rights.
            let vault = self.rollup.ephemeral_vault.to_account_info();
            EphemeralAccount::new(self.island, self.gate, &vault)
                .with_signer_seeds(&[island_seeds, gate_seeds])
                .create(GATE_SIZE as u32)?;
        }
        self.permission()
            .create(Vec::new(), &[island_seeds, gate_seeds])
    }

    pub fn grant(
        &self,
        week: &mut Week,
        island: &mut Island,
        owner: &mut Player,
        visitor: &mut Player,
    ) -> Result<()> {
        require!(island.gate_requested, MarketError::NoGateRequest);
        let index = usize::from(island.idx);
        let mask = 1 << visitor.island_idx;
        require!(
            week.gates_open[index] & mask == 0,
            MarketError::GateAlreadyRequested
        );
        require!(visitor.passes_used < MAX_PASSES, MarketError::PassLimit);
        require!(
            week.gates_open[index].count_ones() < (MAX_MEMBERS - 1) as u32,
            MarketError::GateFull
        );
        require!(visitor.coins >= GATE_TIP, MarketError::InsufficientCoins);

        let (address, bump) = gate_address(self.island.key, &visitor.owner);
        require_keys_eq!(*self.gate.key, address, MarketError::AccountMismatch);
        let island_seeds: &[&[u8]] = &[
            ISLAND_SEED,
            island.week.as_ref(),
            &[island.idx],
            &[island.bump],
        ];
        let gate_seeds: &[&[u8]] = &[
            GATE_SEED,
            self.island.key.as_ref(),
            visitor.owner.as_ref(),
            &[bump],
        ];
        self.permission().update(
            true,
            members([island.owner, visitor.owner]),
            &[island_seeds, gate_seeds],
        )?;
        write_account(
            self.gate,
            &GatePass {
                island: *self.island.key,
                visitor: visitor.owner,
                granted_tick: week.tick,
                expires_tick: ROT_TICK,
                tip_paid: GATE_TIP,
                bump,
            },
        )?;

        visitor.coins -= GATE_TIP;
        visitor.passes_used += 1;
        owner.coins = owner
            .coins
            .checked_add(GATE_TIP)
            .ok_or(MarketError::CoinOverflow)?;
        island.gate_requested = false;
        week.gates_open[index] |= mask;
        self.update_island(week, island, island_seeds)
    }

    pub fn revoke(&self, week: &mut Week, island: &Island, visitor: &Player) -> Result<()> {
        let mut pass = checked_pass(self.gate, self.island.key, &visitor.owner)?;
        require!(pass.live(week.tick), MarketError::NoGatePass);
        pass.expires_tick = week.tick;
        write_account(self.gate, &pass)?;
        week.gates_open[usize::from(island.idx)] &= !(1 << visitor.island_idx);
        let seeds: &[&[u8]] = &[
            ISLAND_SEED,
            island.week.as_ref(),
            &[island.idx],
            &[island.bump],
        ];
        self.update_island(week, island, seeds)
    }

    pub fn reveal(&self, island: &Island, visitor: &Pubkey) -> Result<()> {
        let (address, bump) = gate_address(self.island.key, visitor);
        require_keys_eq!(*self.gate.key, address, MarketError::AccountMismatch);
        let island_seeds: &[&[u8]] = &[
            ISLAND_SEED,
            island.week.as_ref(),
            &[island.idx],
            &[island.bump],
        ];
        let gate_seeds: &[&[u8]] = &[
            GATE_SEED,
            self.island.key.as_ref(),
            visitor.as_ref(),
            &[bump],
        ];
        self.permission()
            .update(false, Vec::new(), &[island_seeds, gate_seeds])
    }

    fn permission(&self) -> Permission<'_, 'info> {
        Permission {
            subject: self.gate,
            account: self.gate_permission,
            payer: self.island,
            rollup: self.rollup,
        }
    }

    fn update_island(&self, week: &Week, island: &Island, seeds: &[&[u8]]) -> Result<()> {
        let mask = week.gates_open[usize::from(island.idx)];
        let visitors = week
            .owners
            .iter()
            .enumerate()
            .filter(|(index, _)| mask & (1 << index) != 0)
            .map(|(_, key)| *key);
        let members = members(std::iter::once(island.owner).chain(visitors));
        Permission {
            subject: self.island,
            account: self.island_permission,
            payer: self.island,
            rollup: self.rollup,
        }
        .update(true, members, &[seeds])
    }
}

pub fn checked_pass(info: &AccountInfo<'_>, island: &Pubkey, visitor: &Pubkey) -> Result<GatePass> {
    require_keys_eq!(
        *info.key,
        gate_address(island, visitor).0,
        MarketError::NoGatePass
    );
    let pass: GatePass = read_account(info).map_err(|_| error!(MarketError::NoGatePass))?;
    require!(
        pass.island == *island && pass.visitor == *visitor,
        MarketError::NoGatePass
    );
    Ok(pass)
}

pub fn buy(player: &mut Player, qty: u16, sunday_price: u16) -> Result<()> {
    require!((1..=BUY_CAP).contains(&qty), MarketError::BuyCap);
    require!(!player.bought, MarketError::AlreadyBought);
    let cost = u64::from(qty) * u64::from(sunday_price);
    require!(player.coins >= cost, MarketError::InsufficientCoins);
    player.coins -= cost;
    player.rots = qty;
    player.bought = true;
    Ok(())
}

pub fn sell(player: &mut Player, qty: u16, price: u16) -> Result<()> {
    require!(qty > 0, MarketError::BadSellQuantity);
    require!(qty <= player.rots, MarketError::InsufficientRots);
    player.coins = player
        .coins
        .checked_add(u64::from(qty) * u64::from(price))
        .ok_or(MarketError::CoinOverflow)?;
    player.rots -= qty;
    Ok(())
}

pub fn tick_market<'info>(
    week: &mut Week,
    accounts: &WeekAccounts<'_, 'info>,
    rollup: &RollupPrograms<'info>,
    now: i64,
) -> Result<()> {
    let target = week.tick_at(now).max(week.tick);
    let mut human: Player = read_account(&accounts.players[0])?;
    for index in 1..ISLAND_COUNT {
        let island_info = &accounts.islands[index];
        let player_info = &accounts.players[index];
        let mut island: Island = read_account(island_info)?;
        let mut bot: Player = read_account(player_info)?;

        if week.phase == Phase::Sunday && !bot.bought {
            buy(&mut bot, BUY_CAP, island.sunday_price)?;
        }
        if bot.rots > 0 {
            for tick in (week.tick + 1)..=target.min(ROT_TICK - 1) {
                let price = island.prices[usize::from(tick - 1)];
                if tick == 11 || u32::from(price) * 10 >= u32::from(island.sunday_price) * 13 {
                    let qty = bot.rots;
                    sell(&mut bot, qty, price)?;
                    break;
                }
            }
        }
        if island.gate_requested {
            if target < ROT_TICK && human.passes_used < MAX_PASSES && human.coins >= GATE_TIP {
                let gate = GateAccounts {
                    island: island_info,
                    island_permission: &accounts.island_permissions[index],
                    gate: &accounts.gates[index - 1],
                    gate_permission: &accounts.gate_permissions[index - 1],
                    rollup,
                };
                gate.grant(week, &mut island, &mut bot, &mut human)?;
            } else {
                island.gate_requested = false;
            }
            write_account(island_info, &island)?;
        }
        write_account(player_info, &bot)?;
    }
    write_account(&accounts.players[0], &human)?;

    week.tick = target;
    if target == ROT_TICK {
        rot(week, accounts, rollup)?;
    } else if target > 0 {
        week.phase = Phase::Trading;
        week.next_tick_ts = week.sunday_end_ts + i64::from(target) * week.tick_seconds();
    } else if week.tick_ms == TURBO_TICK_MS {
        let elapsed = (now - week.start_ts) / week.tick_seconds();
        let next = week.start_ts + (elapsed + 1) * week.tick_seconds();
        week.next_tick_ts = next.min(week.sunday_end_ts);
    }
    Ok(())
}

fn rot<'info>(
    week: &mut Week,
    accounts: &WeekAccounts<'_, 'info>,
    rollup: &RollupPrograms<'info>,
) -> Result<()> {
    for index in 0..ISLAND_COUNT {
        let island_info = &accounts.islands[index];
        let player_info = &accounts.players[index];
        let island: Island = read_account(island_info)?;
        let mut player: Player = read_account(player_info)?;
        player.rots = 0;
        week.scoreboard[index] = Score {
            owner: player.owner,
            coins: player.coins,
        };
        write_account(player_info, &player)?;

        let island_seeds: &[&[u8]] = &[
            ISLAND_SEED,
            island.week.as_ref(),
            &[island.idx],
            &[island.bump],
        ];
        let player_seeds: &[&[u8]] = &[
            PLAYER_SEED,
            player.week.as_ref(),
            player.owner.as_ref(),
            &[player.bump],
        ];
        Permission {
            subject: island_info,
            account: &accounts.island_permissions[index],
            payer: island_info,
            rollup,
        }
        .update(false, Vec::new(), &[island_seeds])?;
        Permission {
            subject: player_info,
            account: &accounts.player_permissions[index],
            payer: player_info,
            rollup,
        }
        .update(false, Vec::new(), &[player_seeds])?;
        if index > 0 {
            GateAccounts {
                island: island_info,
                island_permission: &accounts.island_permissions[index],
                gate: &accounts.gates[index - 1],
                gate_permission: &accounts.gate_permissions[index - 1],
                rollup,
            }
            .reveal(&island, &week.owners[0])?;
        }
    }
    week.phase = Phase::Rotted;
    week.gates_open = [0; ISLAND_COUNT];
    week.next_tick_ts = 0;
    Ok(())
}
