#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
export NO_DNA=1
export AVM_HOME="${AVM_HOME:-$project_dir/.toolchain/avm}"
export CARGO_HOME="${CARGO_HOME:-$project_dir/.toolchain/cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$project_dir/.toolchain/rustup}"
export PATH="$AVM_HOME/bin:$CARGO_HOME/bin:$project_dir/.toolchain/agave/solana-release/bin:$PATH"

rustc --version
cargo --version
solana --version
solana-keygen --version
cargo build-sbf --version
avm --version
anchor --version
printf 'Node %s\n' "$(node --version)"
printf 'npm %s\n' "$(npm --version)"
