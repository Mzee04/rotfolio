# Rotfolio M3 devnet evidence

Both consecutive runs of `npx ts-mocha -t 300000 tests/week.ts` passed on 24 November 2026 against the same devnet program upgrade.

- [Rotfolio program on Solana devnet](https://explorer.solana.com/address/9czd3zpazBa4fLBcNihWyKEgeKkZ4K8xEdoMWeY5Zj9b?cluster=devnet)
- [M3 program upgrade](https://explorer.solana.com/tx/261yQSwTNAZyfLPQ4mP6axdt8KyGNNckUShqow5oqHfrUZwqJaQPTP7jEzSj1kfnjWniu4FGvvmvPqsSF81nFtK7?cluster=devnet)

| Run | Duration | Settled Week | Delegation | VRF request | Settle request |
| --- | --- | --- | --- | --- | --- |
| 1 | 111.4 s | [Week 1](https://explorer.solana.com/address/39XFGEhTrMDrcRJpRMRuAACxALdLV6UqbWbRbScgFEs9?cluster=devnet) | [Solana devnet](https://explorer.solana.com/tx/aM8yaXm4bPap2LBL57T1WyAUdTCzwwNHwsVuj5f9JNY59jDfGw2snviC6TRPBmBN1LxL37HdFquX1rDVSfaujNp?cluster=devnet) | [MagicBlock devnet TEE](https://explorer.solana.com/tx/3Czuk2FqUcqpJCET9M2Q9KhSdKp9nspRV7ZD9Z2KbP4ipwjdq7o6ywYfgpEhTVrKUYFKo3quNMuhq285CTAiVqMm?cluster=custom&customUrl=https%3A%2F%2Fdevnet-tee.magicblock.app) | [MagicBlock devnet TEE](https://explorer.solana.com/tx/iaGwWTTKKsviDJAtmiPhtA2AJcQrfUdrsL9hUcmWEgmV8jR37uhbKyfPB2WsA2GwCodax45iHjiuBeada9Hf243?cluster=custom&customUrl=https%3A%2F%2Fdevnet-tee.magicblock.app) |
| 2 | 113.6 s | [Week 2](https://explorer.solana.com/address/9w14NSQtaVt98mWWeBkgViAdVhiQSUHoiSMKfcZ5tKdK?cluster=devnet) | [Solana devnet](https://explorer.solana.com/tx/nKfQqDCgCnK8eSgFKzqASnvqpZvCxSuSo22aKaMWtUNtaSjz2SSqsu8ghoGhL6KMj3NgbjKzr4UMB513GygaiqL?cluster=devnet) | [MagicBlock devnet TEE](https://explorer.solana.com/tx/4zMV9LjASvYwX6WyGjLyUurjJpr9PQvTuBTnbdPkTv9tW5hQbX3cs41GRbUKxpCXvzS2F6omGHxgUZEin7PtSQXi?cluster=custom&customUrl=https%3A%2F%2Fdevnet-tee.magicblock.app) | [MagicBlock devnet TEE](https://explorer.solana.com/tx/2N1TYzKmNJDTqsD56isbgPPXmKasKJh9x8LwXiyQia2RhfJRQ6uiXxFW3GGah5jkQikd7rNGTY4aJxUxvzhjgvTw?cluster=custom&customUrl=https%3A%2F%2Fdevnet-tee.magicblock.app) |

Each run checked permissioned reads, the 100-Rot buy and 101-Rot rejection, gate-authorized selling and revocation, the three-pass limit, crank timing, rot, the public scoreboard, and return of all nine delegated accounts to the Rotfolio program on Solana devnet.
