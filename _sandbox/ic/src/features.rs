use serde_json::{json, Value};

/* WHAT THIS ic CAN BE ASKED TO DO, SAID BY ic ITSELF (2026-10-20). The machine agent advertises a device's optional ops
in its facts (the contract's DeviceFeatureSchema), and a page offers only what works. It used to read them off each
verb's `--help` (a flag listed is a feature had), which cannot say anything a flag does not: that a listing changed what
it means, as `rollbackTargets` did on 2026-10-19 when it began to list only the ways back that can be reached. A host
still on an ic from before that lists a pruned dev build as a way back, a `0.0.0` row nothing can download; the editor
reads the feature below to know whether the rows it is shown are ic's reachable list, rather than filtering every
host's rows blindly. `ic features --json` is this list, and the agent asks it first, scraping help only for an ic from
before this verb. golden/ic-features.json in the contract is this list, held there by both sides' tests. */

/// Every optional op this ic implements, in the contract's words. A word is added here in the release that implements
/// it, never sooner: an agent advertises exactly this.
pub const FEATURES: [&str; 6] = [
    "reshape-later",
    "set-shape",
    "rollback-to",
    "background-prepare",
    "sleep",
    // `sandbox list --json`'s `rollbackTargets` names only ways back a rollback can reach (versions.rs `ways_back`).
    "reachable-ways-back",
];

/// The answer, as one JSON line.
pub fn answer() -> Value {
    json!({ "features": FEATURES })
}

/// `ic features [--json]`.
pub fn run(as_json: bool) -> crate::util::Result<()> {
    if as_json {
        // allow(terminal-output): the --json answer, one line the machine agent reads.
        println!("{}", answer());
    } else {
        for feature in FEATURES {
            // allow(terminal-output): the plain answer, one feature a line.
            println!("{feature}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN: &str = include_str!("../../../_shared/sandbox-contract/golden/ic-features.json");

    #[test]
    fn the_features_ic_says_it_has_are_the_contracts_golden_list() {
        let golden: Value = serde_json::from_str(GOLDEN).expect("golden parses");
        assert_eq!(answer(), golden);
    }
}
