use anchor_lang::prelude::*;

#[error_code]
pub enum MarketError {
    #[msg("Tick interval must be 5000, 10000, or 25000 milliseconds")]
    BadTickInterval,
    #[msg("The supplied accounts do not belong to this week and island")]
    AccountMismatch,
    #[msg("Only the week creator may perform this operation")]
    NotCreator,
    #[msg("This instruction is unavailable in the current phase")]
    WrongPhase,
    #[msg("This session already owns an island")]
    AlreadyJoined,
    #[msg("All four islands are occupied")]
    WeekFull,
    #[msg("All four islands must be occupied before the week starts")]
    WeekIncomplete,
    #[msg("Delegate all islands and players before delegating the week")]
    DelegateWeekLast,
    #[msg("Every island and player must have a private permission before starting")]
    PermissionsMissing,
    #[msg("Wait for the outstanding VRF request before retrying")]
    VrfPending,
    #[msg("Buy quantity must be between 1 and 100 Rots")]
    BuyCap,
    #[msg("You already bought Rots this week")]
    AlreadyBought,
    #[msg("This player has insufficient coins")]
    InsufficientCoins,
    #[msg("This player has insufficient Rots")]
    InsufficientRots,
    #[msg("This player has already used three gate passes this week")]
    PassLimit,
    #[msg("This island already has three visitors")]
    GateFull,
    #[msg("The human player can visit house islands")]
    InvalidVisit,
    #[msg("This gate request or pass already exists")]
    GateAlreadyRequested,
    #[msg("There is no pending request for this visitor")]
    NoGateRequest,
    #[msg("Only the island owner may manage its gate")]
    NotIslandOwner,
    #[msg("You need a live gate pass to sell at this island")]
    NoGatePass,
    #[msg("Sell quantity must be positive")]
    BadSellQuantity,
    #[msg("Coin arithmetic overflowed")]
    CoinOverflow,
    #[msg("Only the human player may open or finish Sunday")]
    NotHumanPlayer,
}
