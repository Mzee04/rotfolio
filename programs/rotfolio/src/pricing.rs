//! Deterministic weekly prices derived from the VRF result.

pub const ISLAND_COUNT: usize = 4;
pub const TRADING_TICKS: usize = 12;

const MIN_PRICE: u16 = 20;
const MAX_PRICE: u16 = 660;
const SPLITMIX_INCREMENT: u64 = 0x9e37_79b9_7f4a_7c15;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Pattern {
    BigSpike = 0,
    SmallSpike = 1,
    Decreasing = 2,
    Random = 3,
}

const PATTERNS: [Pattern; ISLAND_COUNT] = [
    Pattern::BigSpike,
    Pattern::SmallSpike,
    Pattern::Decreasing,
    Pattern::Random,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IslandPrices {
    pub pattern: Pattern,
    pub sunday_price: u16,
    pub prices: [u16; TRADING_TICKS],
}

/// Generate the Sunday price and Mon AM through Sat PM prices for each island.
pub fn generate_week(randomness: [u8; 32]) -> [IslandPrices; ISLAND_COUNT] {
    let seed = randomness
        .as_chunks::<8>()
        .0
        .iter()
        .fold(0u64, |seed, word| {
            mix64(
                seed.wrapping_add(u64::from_le_bytes(*word))
                    .wrapping_add(SPLITMIX_INCREMENT),
            )
        });

    let mut shuffle_rng = SplitMix64::stream(seed, 0);
    let mut patterns = PATTERNS;
    for end in (1..ISLAND_COUNT).rev() {
        let index = shuffle_rng.inclusive(0, end as u16) as usize;
        patterns.swap(end, index);
    }

    std::array::from_fn(|index| {
        let pattern = patterns[index];
        let mut rng = SplitMix64::stream(seed, index as u64 + 1);
        let sunday_price = rng.inclusive(90, 110);
        IslandPrices {
            pattern,
            sunday_price,
            prices: trading_prices(pattern, sunday_price, &mut rng)
                .map(|price| price.clamp(MIN_PRICE, MAX_PRICE)),
        }
    })
}

fn trading_prices(
    pattern: Pattern,
    sunday_price: u16,
    rng: &mut SplitMix64,
) -> [u16; TRADING_TICKS] {
    match pattern {
        Pattern::BigSpike => {
            let peak = rng.inclusive(2 * sunday_price + 1, 6 * sunday_price);
            spike_prices(sunday_price, peak, 3, rng)
        }
        Pattern::SmallSpike => {
            let peak = rng.inclusive(percent(sunday_price, 135), percent(sunday_price, 195));
            spike_prices(sunday_price, peak, 2, rng)
        }
        Pattern::Decreasing => {
            let mut prices = [0; TRADING_TICKS];
            prices[0] = percent(sunday_price, rng.inclusive(84, 95));
            for tick in 1..TRADING_TICKS {
                prices[tick] = prices[tick - 1] - rng.inclusive(3, 5);
            }
            prices
        }
        Pattern::Random => std::array::from_fn(|_| percent(sunday_price, rng.inclusive(45, 145))),
    }
}

fn spike_prices(
    sunday_price: u16,
    peak: u16,
    ramp: u16,
    rng: &mut SplitMix64,
) -> [u16; TRADING_TICKS] {
    let peak_tick = rng.inclusive(ramp - 1, TRADING_TICKS as u16 - ramp);
    std::array::from_fn(|tick| {
        let baseline = percent(sunday_price, rng.inclusive(45, 85));
        let weight = ramp.saturating_sub(peak_tick.abs_diff(tick as u16));
        baseline + (peak - baseline) * weight / ramp
    })
}

fn percent(price: u16, percentage: u16) -> u16 {
    price * percentage / 100
}

struct SplitMix64(u64);

impl SplitMix64 {
    fn stream(seed: u64, index: u64) -> Self {
        Self(mix64(
            seed.wrapping_add(SPLITMIX_INCREMENT.wrapping_mul(index)),
        ))
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(SPLITMIX_INCREMENT);
        mix64(self.0)
    }

    fn inclusive(&mut self, low: u16, high: u16) -> u16 {
        let span = u64::from(high - low) + 1;
        // Reject the short remainder so that each possible result is equally likely.
        let threshold = span.wrapping_neg() % span;
        loop {
            let draw = self.next_u64();
            if draw >= threshold {
                return low + (draw % span) as u16;
            }
        }
    }
}

// SplitMix64's finalizer. https://prng.di.unimi.it/splitmix64.c
fn mix64(mut value: u64) -> u64 {
    value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn random_seeds() -> impl Iterator<Item = [u8; 32]> {
        let mut state = 0x082e_fa98_ec4e_6c89u64;
        std::iter::repeat_with(move || {
            let mut seed = [0; 32];
            for word in seed.chunks_exact_mut(8) {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                word.copy_from_slice(&state.to_le_bytes());
            }
            seed
        })
        .take(1_000)
    }

    fn sample_seeds() -> impl Iterator<Item = [u8; 32]> {
        [[0; 32], [u8::MAX; 32]].into_iter().chain(random_seeds())
    }

    #[test]
    fn splitmix64_matches_reference_sequence() {
        let mut rng = SplitMix64(0);
        assert_eq!(rng.next_u64(), 0xe220_a839_7b1d_cdaf);
        assert_eq!(rng.next_u64(), 0x6e78_9e6a_a1b9_65f4);
        assert_eq!(rng.next_u64(), 0x06c4_5d18_8009_454f);
    }

    #[test]
    fn shuffle_assigns_each_pattern_once_and_covers_all_permutations() {
        let mut permutations = HashSet::new();
        for seed in sample_seeds() {
            let patterns = generate_week(seed).map(|island| island.pattern);
            for pattern in PATTERNS {
                assert_eq!(patterns.iter().filter(|&&item| item == pattern).count(), 1);
            }
            permutations.insert(patterns.map(|pattern| pattern as u8));
        }
        assert_eq!(permutations.len(), 24);
    }

    #[test]
    fn sunday_and_trading_prices_stay_within_bounds() {
        for seed in sample_seeds() {
            for island in generate_week(seed) {
                assert!((90..=110).contains(&island.sunday_price));
                assert_eq!(island.prices.len(), 12);
                assert!(island.prices.iter().all(|price| (20..=660).contains(price)));
            }
        }
    }

    #[test]
    fn big_spike_exceeds_twice_sunday_and_stays_within_six_times() {
        for seed in sample_seeds() {
            let big_spike = generate_week(seed)
                .into_iter()
                .find(|island| island.pattern == Pattern::BigSpike)
                .unwrap();
            let peak = big_spike.prices.into_iter().max().unwrap();
            assert!(peak > 2 * big_spike.sunday_price);
            assert!(peak <= 6 * big_spike.sunday_price);
        }
    }

    #[test]
    fn small_spike_and_decreasing_tracks_have_their_expected_shapes() {
        for seed in sample_seeds() {
            for island in generate_week(seed) {
                match island.pattern {
                    Pattern::SmallSpike => {
                        let peak = island.prices.into_iter().max().unwrap();
                        assert!(peak > island.sunday_price && peak < 2 * island.sunday_price);
                    }
                    Pattern::Decreasing => {
                        assert!(island.prices[0] < island.sunday_price);
                        assert!(island.prices.windows(2).all(|pair| pair[0] > pair[1]));
                    }
                    _ => {}
                }
            }
        }
    }

    #[test]
    fn a_thousand_random_seeds_produce_deterministic_weeks() {
        let mut count = 0;
        for seed in random_seeds() {
            assert_eq!(generate_week(seed), generate_week(seed));
            count += 1;
        }
        assert_eq!(count, 1_000);
    }

    #[test]
    fn all_vrf_bytes_contribute_to_the_week_seed() {
        let baseline = generate_week([0; 32]);
        for index in 0..32 {
            let mut seed = [0; 32];
            seed[index] = 1;
            assert_ne!(generate_week(seed), baseline);
        }
    }
}
