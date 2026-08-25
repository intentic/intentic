/* `ic runner` — a RUNNER on this machine: a sandbox-image container that belongs to a parent sandbox instead
 * of a person, executing turns that sandbox dispatches (design: docs/remote-runners-plan.md at the workspace
 * root; the daemon halves are `sandbox/src/runners/` and `sandbox-contract`'s runner contract).
 *
 * Phase-1 skeleton: the argument surface exists so the host agent, the platform's cards and hand-typed runs
 * bind against final spellings from day one (the surface test in main.rs guards them like every other verb),
 * and every body is an honest refusal pointing at the design. `up` will compose the same run contract
 * `sandbox connect` executes, minus the platform: no setup code, no tunnel container, no public name — the
 * runner env (RUNNER_PARENT_URL / RUNNER_PAIR_TOKEN) instead, and the pairing comes from the parent sandbox
 * rather than the platform. */

use crate::util::{Fail, Result};

const NOT_YET: &str = "`ic runner` is designed but not implemented yet — see docs/remote-runners-plan.md in the workspace this sandbox serves.";

/// `parent_url` is where the runner will dial; the pairing (single-use, minted at the parent's
/// POST /system/runners/pair) rides into the container env and is redeemed once for the durable token.
pub fn up(parent_url: String, _pair_token: String, _name: Option<String>) -> Result<()> {
    Err(Fail(format!(
        "{NOT_YET} `up` would boot the sandbox image with runner env (no setup code, no tunnel container) dialing {parent_url}."
    )))
}

pub fn list() -> Result<()> {
    Err(Fail(NOT_YET.to_string()))
}

pub fn remove(_name: String) -> Result<()> {
    Err(Fail(NOT_YET.to_string()))
}
