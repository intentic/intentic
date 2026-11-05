use crate::util::{bail, Result};

/* A SANDBOX'S SHAPE: the owner's own ask for its share of this machine, whole. Every field is a value; nothing here means "leave it". */

/// The owner's ask as a container carries it (SANDBOX_MEMORY, SANDBOX_CPUS, SANDBOX_SWAP and their own SANDBOX_RUNTIME
/// tokens), or as it is saved for the next restart (the channel record's `desired_*` keys). ABSOLUTE on purpose: a saved delta
/// had to be laid over whatever ran by every reader, and each reader did it differently.
///
/// It is the owner's ASK, not docker's answer: the approved environment's own directives ride beside it untouched
/// (SANDBOX_OVERLAY_RUNTIME), the contract bounds a cap to the machine, and a host without the NVIDIA runtime drops
/// the GPU. `None` on a cap is the contract's default: the share derived from this machine, or every core.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Shape {
    /// Whole GiB in the contract's spelling, `12g`.
    pub memory: Option<String>,
    /// Whole cores, `4`.
    pub cpus: Option<String>,
    pub privileged: bool,
    pub gpus: bool,
    /// (2026-11-05) The swap the sandbox's `workload` cgroup leaf may page into, whole GiB in the same spelling, `4g`: the
    /// swap ALONE, not memory plus swap (docker's `--memory-swap` is the sum; ic and the run contract add the cap).
    /// `None` is the default the sandbox derives from its cap (a quarter of it, 1 to 4 GiB, and of the machine's memory
    /// where it has no cap: `defaultSandboxSwapGib` in @intentic/sandbox-run, [`default_swap_gib`] here). The bound that
    /// stops a runaway: on 2026-11-05 one process on rog paged 33 GB into a swap nothing bounded, because the engine
    /// ignored `--memory-swap`, and the WSL VM thrashed for 1 h 48 m. The sandbox holds its own workload leaf to this,
    /// whatever the engine does.
    pub swap: Option<String>,
}

/// What `ic sandbox reshape` / `ic sandbox shape` were asked to change. Every field is "leave it" when None. The two
/// caps carry the contract's own spellings (`12g`, `4`) or the EMPTY string, which is the contract's "clear this" —
/// main.rs maps the verb's `default` onto it.
#[derive(Default, Clone, Debug, PartialEq, Eq)]
pub struct Ask {
    pub memory: Option<String>,
    pub cpus: Option<String>,
    pub privileged: Option<bool>,
    pub gpus: Option<bool>,
    pub swap: Option<String>,
}

/// The env var a container carries the owner's swap ask in (`<n>g`), and the file ic writes into a running container when
/// the swap alone is changed now (`{"swapGib": n}`, wins over the env var; on the container's own filesystem, so a
/// recreate starts without it and carries the value in the env var instead). Named once, in the sandbox's
/// system/resources/memory-records.ts (SWAP_ENV, WORKLOAD_BOUNDS_OVERRIDE): these are copies, ic cannot import it.
pub const SWAP_ENV: &str = "SANDBOX_SWAP";
pub const WORKLOAD_BOUNDS_OVERRIDE: &str = "/run/intentic/workload-bounds.json";

const GIB: u64 = 1024 * 1024 * 1024;

/// The default swap bound in whole GiB for a cap of `cap_bytes`: a quarter of the cap in whole GiB, rounded up, at least
/// 1 and at most 4. Mirrors `defaultSandboxSwapGib` in @intentic/sandbox-run (_shared/sandbox-run/src/index.ts), the one
/// TypeScript formula: it sizes `--memory-swap`, and the sandbox holds its workload leaf to it (daemon-cgroup.ts, and the
/// entrypoint's shell copy). ic cannot import it, so this is a copy, and the copies must agree or the bound ic writes or
/// reports is not the one the sandbox holds. The caller passes what the sandbox passes: its cap, or the machine's memory
/// for a sandbox with none (containment.rs `default_basis`). Never 0: a cgroup with no swap livelocks reclaiming
/// file-backed pages instead of reaching its own OOM. Pure.
pub fn default_swap_gib(cap_bytes: u64) -> u64 {
    let cap_gib = (cap_bytes / GIB).max(1);
    cap_gib.div_ceil(4).clamp(1, 4)
}

/// A whole-GiB spelling (`4g`) as a number of GiB; None for anything else. Pure.
pub fn gib_of(spelled: &str) -> Option<u64> {
    whole(spelled.strip_suffix('g'))
}

/// A NUL-framed env with the swap ask set to `swap`: every SANDBOX_SWAP it carried dropped, and the new one appended when
/// there is one. What a recreate hands the run contract, so a contract that replays SANDBOX_SWAP replays the shape this
/// recreate applies rather than the one the old container was made with (the contract keeps each name's first
/// occurrence, so leaving the old one in would win over an appended new one). Pure.
pub fn with_swap_env(env_nul: &[u8], swap: Option<&str>) -> Vec<u8> {
    let prefix = format!("{SWAP_ENV}=");
    let mut out: Vec<u8> = Vec::with_capacity(env_nul.len() + 24);
    for pair in env_nul.split(|byte| *byte == 0) {
        if pair.is_empty() || pair.starts_with(prefix.as_bytes()) {
            continue;
        }
        out.extend_from_slice(pair);
        out.push(0);
    }
    if let Some(swap) = swap.map(str::trim).filter(|swap| !swap.is_empty()) {
        out.extend_from_slice(format!("{SWAP_ENV}={swap}").as_bytes());
        out.push(0);
    }
    out
}

/// The `-e SANDBOX_SWAP=…` a run line needs from ic itself: none when the run contract already put the variable on it (an
/// image whose contract replays SANDBOX_SWAP, from 2026-11-05), or when there is no ask to carry; the pair otherwise.
///
/// WHY ic STAMPS IT RATHER THAN TRUSTING THE CONTRACT ALONE: the run contract replays only the names it lists, and every
/// image published before this field lists none such (as with HOST_ENV, connect.rs). A rollback onto one of them, or a
/// reshape of a sandbox still on one, would silently drop the owner's swap from the container's env, and with it from
/// every recreate after (the env IS where the running shape is read from). Stamped beside the contract's line it
/// survives either way. Never both: docker keeps both copies of a variable named twice, and the one a process reads is
/// then a matter of which libc it links. Pure.
pub fn swap_stamp(contract_argv: &[String], swap: Option<&str>) -> Vec<String> {
    let prefix = format!("{SWAP_ENV}=");
    let carried = contract_argv
        .windows(2)
        .any(|pair| pair[0] == "-e" && pair[1].starts_with(prefix.as_str()));
    match swap.map(str::trim).filter(|swap| !swap.is_empty()) {
        Some(swap) if !carried => vec!["-e".to_string(), format!("{SWAP_ENV}={swap}")],
        _ => Vec::new(),
    }
}

/// A cap as the contract's JSON spells it: a positive whole number, or `null` for the default (the empty string here).
fn cap_field(field: &str, value: &serde_json::Value, unit: &str) -> Result<String> {
    match value {
        serde_json::Value::Null => Ok(String::new()),
        serde_json::Value::Number(number) => match number.as_u64().filter(|n| *n > 0) {
            Some(n) => Ok(format!("{n}{unit}")),
            None => bail!(
                "{field} is a whole number above zero, or null for the default; got {number}."
            ),
        },
        other => {
            bail!("{field} is a whole number above zero, or null for the default; got {other}.")
        }
    }
}

fn switch_field(field: &str, value: &serde_json::Value) -> Result<bool> {
    match value.as_bool() {
        Some(on) => Ok(on),
        None => bail!("{field} is true or false; got {value}."),
    }
}

impl Ask {
    /// The ask from `--set FIELD=JSON` pairs: the sandbox contract's own SandboxShape, one field per pair, so a caller
    /// passes the contract's object and never spells a flag of ours. STRICT, like every order a device is sent: a
    /// field this ic does not know is refused rather than dropped, and so is one named twice.
    pub fn from_fields<S: AsRef<str>>(pairs: &[S]) -> Result<Ask> {
        let mut ask = Ask::default();
        let mut seen: Vec<&str> = Vec::new();
        for pair in pairs {
            let pair = pair.as_ref();
            let Some((field, raw)) = pair.split_once('=') else {
                bail!("--set takes FIELD=JSON, e.g. memoryGib=12; got `{pair}`.");
            };
            if seen.contains(&field) {
                bail!("--set names {field} twice.");
            }
            seen.push(field);
            let value: serde_json::Value = match serde_json::from_str(raw) {
                Ok(value) => value,
                Err(_) => {
                    bail!("--set {field}= takes a JSON value (12, null, true, false); got `{raw}`.")
                }
            };
            match field {
                "memoryGib" => ask.memory = Some(cap_field(field, &value, "g")?),
                "cpus" => ask.cpus = Some(cap_field(field, &value, "")?),
                "privileged" => ask.privileged = Some(switch_field(field, &value)?),
                "gpu" => ask.gpus = Some(switch_field(field, &value)?),
                "swapGib" => ask.swap = Some(cap_field(field, &value, "g")?),
                other => bail!(
                    "this ic does not know the shape field `{other}` (it knows memoryGib, cpus, privileged, gpu and swapGib): update ic."
                ),
            }
        }
        Ok(ask)
    }

    /// Nothing asked: every field "leave it".
    pub fn is_empty(&self) -> bool {
        self.memory.is_none()
            && self.cpus.is_none()
            && self.privileged.is_none()
            && self.gpus.is_none()
            && self.swap.is_none()
    }

    /// Whether the ask names the swap and nothing else.
    pub fn swap_only(&self) -> bool {
        self.swap.is_some()
            && Ask {
                swap: None,
                ..self.clone()
            }
            .is_empty()
    }
}

// The directive tokens the two switches stand for, in the contract's single-token spelling
// (@intentic/sandbox-run RUNTIME_DIRECTIVES). Named here only to read and edit the owner's list; validated in the image.
pub const PRIVILEGED_TOKEN: &str = "--privileged";
pub const GPUS_TOKEN: &str = "--gpus=all";

/// A cap as the contract spells it: empty is "back to the default".
fn cap(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

impl Shape {
    /// The shape a container runs with, from its env list (`NAME=value` entries, as `docker inspect` gives them).
    pub fn from_env<S: AsRef<str>>(env: &[S]) -> Shape {
        let value = |name: &str| {
            let prefix = format!("{name}=");
            env.iter().find_map(|entry| {
                entry
                    .as_ref()
                    .strip_prefix(prefix.as_str())
                    .map(str::to_string)
            })
        };
        let runtime = value("SANDBOX_RUNTIME").unwrap_or_default();
        let has = |token: &str| runtime.split_whitespace().any(|have| have == token);
        Shape {
            memory: cap(value("SANDBOX_MEMORY").as_deref()),
            cpus: cap(value("SANDBOX_CPUS").as_deref()),
            privileged: has(PRIVILEGED_TOKEN),
            gpus: has(GPUS_TOKEN),
            swap: cap(value(SWAP_ENV).as_deref()),
        }
    }

    /// The shape with the swap a live reshape wrote into the running container (`ic sandbox shape --set swapGib=… --when
    /// now`, which changes no env var): the container runs with that one now, and the next recreate carries it in its env.
    /// `live` is None when no live reshape left one, `Some(None)` when it set the swap back to the default (which then
    /// follows the cap again rather than staying pinned at the number it came to), `Some(Some(gib))` for the owner's own.
    pub fn with_live_swap(self, live: Option<Option<u64>>) -> Shape {
        match live {
            Some(Some(gib)) if gib >= 1 => Shape {
                swap: Some(format!("{gib}g")),
                ..self
            },
            Some(None) => Shape { swap: None, ..self },
            _ => self,
        }
    }

    /// Whether `other` differs from this shape in the swap and in nothing else.
    pub fn differs_only_in_swap(&self, other: &Shape) -> bool {
        self.swap != other.swap
            && Shape {
                swap: None,
                ..self.clone()
            } == Shape {
                swap: None,
                ..other.clone()
            }
    }

    /// This shape with `ask` laid over it: a field the ask names wins, a field it leaves stays.
    pub fn with(&self, ask: &Ask) -> Shape {
        Shape {
            memory: match &ask.memory {
                Some(value) => cap(Some(value)),
                None => self.memory.clone(),
            },
            cpus: match &ask.cpus {
                Some(value) => cap(Some(value)),
                None => self.cpus.clone(),
            },
            privileged: ask.privileged.unwrap_or(self.privileged),
            gpus: ask.gpus.unwrap_or(self.gpus),
            swap: match &ask.swap {
                Some(value) => cap(Some(value)),
                None => self.swap.clone(),
            },
        }
    }

    /// The whole shape as an ask that names every field, which is what a recreate seeds the contract with.
    pub fn as_ask(&self) -> Ask {
        Ask {
            memory: Some(self.memory.clone().unwrap_or_default()),
            cpus: Some(self.cpus.clone().unwrap_or_default()),
            privileged: Some(self.privileged),
            gpus: Some(self.gpus),
            swap: Some(self.swap.clone().unwrap_or_default()),
        }
    }

    /// The spelling the contract takes, checked before anything is saved or restarted. The image's contract is
    /// still the judge of the values (its floor, the engine's cores); this refuses what it could never accept.
    pub fn check_spelling(&self) -> Result<()> {
        if let Some(memory) = &self.memory {
            if whole(memory.strip_suffix('g')).is_none() {
                bail!("memory must be whole GiB spelled like 12g (or `default`), not '{memory}'.");
            }
        }
        if let Some(cpus) = &self.cpus {
            if whole(Some(cpus)).is_none() {
                bail!("cpus must be a whole number of cores, at least 1 (or `default`), not '{cpus}'.");
            }
        }
        if let Some(swap) = &self.swap {
            if gib_of(swap).is_none() {
                bail!("swap must be whole GiB spelled like 4g, at least 1g (or `default`), not '{swap}'.");
            }
        }
        Ok(())
    }

    /// The shape in words, for the lines that say what was saved or is being applied.
    pub fn describe(&self) -> String {
        let memory = self
            .memory
            .as_ref()
            .map_or("memory default".to_string(), |gib| format!("memory {gib}"));
        let cpus = self
            .cpus
            .as_ref()
            .map_or("cpus default".to_string(), |cores| format!("cpus {cores}"));
        let switch = |on: bool| if on { "on" } else { "off" };
        let swap = self
            .swap
            .as_ref()
            .map_or("swap default".to_string(), |gib| format!("swap {gib}"));
        format!(
            "{memory}, {cpus}, privileged {}, gpus {}, {swap}",
            switch(self.privileged),
            switch(self.gpus)
        )
    }

    /// The shape in the sandbox contract's vocabulary (`SandboxShapeSchema`): whole numbers, null for the default.
    /// What `ic sandbox list --json` prints, so every caller reads it without learning ic's spelling.
    pub fn to_json(&self) -> serde_json::Value {
        let number = |value: &Option<String>, unit: Option<char>| {
            value
                .as_deref()
                .and_then(|value| whole(unit.map_or(Some(value), |unit| value.strip_suffix(unit))))
                .map_or(serde_json::Value::Null, serde_json::Value::from)
        };
        serde_json::json!({
            "memoryGib": number(&self.memory, Some('g')),
            "cpus": number(&self.cpus, None),
            "privileged": self.privileged,
            "gpu": self.gpus,
            "swapGib": number(&self.swap, Some('g')),
        })
    }

    /* THE CHANNEL RECORD'S SPELLING — one key per field, the first four all or none (record.rs). The fifth, the swap, came
    later (2026-11-05): a record an older ic wrote has four, and its shape reads with the swap left to the default. */

    /// The five record values, `default` standing for a cap left to the contract (an empty value would be an empty key).
    pub fn to_record(&self) -> [String; 5] {
        let cap = |value: &Option<String>| value.clone().unwrap_or_else(|| "default".to_string());
        let switch = |on: bool| (if on { "on" } else { "off" }).to_string();
        [
            cap(&self.memory),
            cap(&self.cpus),
            switch(self.privileged),
            switch(self.gpus),
            cap(&self.swap),
        ]
    }

    /// The shape back from its record values, or None when one of the first four is missing or any is unreadable: a
    /// half-written shape is not one to restart onto. A missing swap is a record an older ic wrote, read as the default.
    pub fn from_record(
        memory: Option<&str>,
        cpus: Option<&str>,
        privileged: Option<&str>,
        gpus: Option<&str>,
        swap: Option<&str>,
    ) -> Option<Shape> {
        let cap = |value: &str| (value != "default").then(|| value.to_string());
        let switch = |value: &str| match value {
            "on" => Some(true),
            "off" => Some(false),
            _ => None,
        };
        let shape = Shape {
            memory: cap(memory?),
            cpus: cap(cpus?),
            privileged: switch(privileged?)?,
            gpus: switch(gpus?)?,
            swap: swap.and_then(cap),
        };
        shape.check_spelling().ok().map(|()| shape)
    }
}

/// A whole number of at least one, in plain digits.
fn whole(digits: Option<&str>) -> Option<u64> {
    let digits = digits?;
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().filter(|value| *value >= 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The swap ask a NUL-framed env carries, read back the way the run contract would: None when it carries none, or
    /// an empty one. Only the tests read an env this way; ic reads a running container's swap through `Shape::from_env`.
    fn swap_in_env_nul(env_nul: &[u8]) -> Option<String> {
        let text = String::from_utf8_lossy(env_nul);
        let prefix = format!("{SWAP_ENV}=");
        text.split('\0')
            .find_map(|pair| pair.strip_prefix(prefix.as_str()))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn shape(memory: Option<&str>, cpus: Option<&str>, privileged: bool, gpus: bool) -> Shape {
        Shape {
            memory: memory.map(str::to_string),
            cpus: cpus.map(str::to_string),
            privileged,
            gpus,
            swap: None,
        }
    }

    #[test]
    fn a_containers_shape_is_the_owners_ask_it_carries_and_nothing_else() {
        let env = [
            "PATH=/usr/bin",
            "SANDBOX_MEMORY=12g",
            "SANDBOX_RUNTIME=--gpus=all --cap-add=NET_ADMIN",
            // The approved environment's demand is not the owner's ask.
            "SANDBOX_OVERLAY_RUNTIME=--privileged",
        ];
        assert_eq!(Shape::from_env(&env), shape(Some("12g"), None, false, true));
        // The swap ask rides its own variable; what a live reshape wrote into the running container wins over it.
        let swapped = Shape::from_env(&["SANDBOX_MEMORY=12g", "SANDBOX_SWAP=2g"]);
        assert_eq!(swapped.swap.as_deref(), Some("2g"));
        assert_eq!(
            swapped
                .clone()
                .with_live_swap(Some(Some(4)))
                .swap
                .as_deref(),
            Some("4g")
        );
        // Set back to the default live: the default it is, not the number the default came to.
        assert_eq!(swapped.clone().with_live_swap(Some(None)).swap, None);
        assert_eq!(swapped.clone().with_live_swap(None), swapped);
        // Nothing asked at all is the contract's defaults, not a guess at what docker enforces.
        assert_eq!(
            Shape::from_env(&["SANDBOX_CPUS="]),
            shape(None, None, false, false)
        );
    }

    #[test]
    fn an_ask_wins_field_by_field_and_empty_is_back_to_the_default() {
        let base = shape(Some("20g"), Some("4"), true, false);
        let ask = Ask {
            memory: Some(String::new()),
            gpus: Some(true),
            ..Ask::default()
        };
        assert_eq!(base.with(&ask), shape(None, Some("4"), true, true));
        assert_eq!(base.with(&Ask::default()), base);
        // The whole shape as an ask names every field, so laying it over anything gives the shape back.
        assert_eq!(Shape::default().with(&base.as_ask()), base);
    }

    #[test]
    fn a_spelling_the_contract_could_never_take_is_refused_before_it_is_saved() {
        assert!(shape(Some("12g"), Some("4"), false, false)
            .check_spelling()
            .is_ok());
        assert!(shape(None, None, false, false).check_spelling().is_ok());
        for bad in ["12", "12G", "0g", "1.5g", "-2g", "g", "12gb"] {
            assert!(
                shape(Some(bad), None, false, false)
                    .check_spelling()
                    .is_err(),
                "{bad}"
            );
        }
        for bad in ["0", "2.5", "four", "4c"] {
            assert!(
                shape(None, Some(bad), false, false)
                    .check_spelling()
                    .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_record_spelling_round_trips_and_a_partial_or_unreadable_one_is_no_shape() {
        let saved = Shape {
            swap: Some("2g".into()),
            ..shape(Some("20g"), None, false, true)
        };
        let [memory, cpus, privileged, gpus, swap] = saved.to_record();
        assert_eq!(
            [&memory, &cpus, &privileged, &gpus, &swap],
            ["20g", "default", "off", "on", "2g"]
        );
        assert_eq!(
            Shape::from_record(
                Some(&memory),
                Some(&cpus),
                Some(&privileged),
                Some(&gpus),
                Some(&swap)
            ),
            Some(saved)
        );
        // A record an older ic wrote has four keys: its shape is whole, with the swap left to the default.
        assert_eq!(
            Shape::from_record(Some("20g"), Some("default"), Some("off"), Some("on"), None),
            Some(shape(Some("20g"), None, false, true))
        );
        assert_eq!(
            Shape::from_record(Some("20g"), None, Some("off"), Some("on"), Some("2g")),
            None
        );
        assert_eq!(
            Shape::from_record(
                Some("20g"),
                Some("default"),
                Some("maybe"),
                Some("on"),
                None
            ),
            None
        );
        assert_eq!(
            Shape::from_record(Some("lots"), Some("default"), Some("off"), Some("on"), None),
            None
        );
        assert_eq!(
            Shape::from_record(
                Some("20g"),
                Some("default"),
                Some("off"),
                Some("on"),
                Some("0g")
            ),
            None
        );
    }

    #[test]
    fn the_json_is_the_contracts_vocabulary() {
        assert_eq!(
            shape(Some("20g"), Some("4"), true, false).to_json(),
            serde_json::json!({ "memoryGib": 20, "cpus": 4, "privileged": true, "gpu": false, "swapGib": null })
        );
        assert_eq!(
            Shape {
                swap: Some("3g".into()),
                ..Shape::default()
            }
            .to_json(),
            serde_json::json!({ "memoryGib": null, "cpus": null, "privileged": false, "gpu": false, "swapGib": 3 })
        );
    }

    #[test]
    fn a_shape_is_described_in_the_order_the_form_shows_it() {
        assert_eq!(
            shape(Some("20g"), None, false, true).describe(),
            "memory 20g, cpus default, privileged off, gpus on, swap default"
        );
        let swapped = Shape {
            swap: Some("4g".into()),
            ..shape(None, None, false, false)
        };
        assert!(swapped.describe().ends_with(", swap 4g"));
    }

    /* `--set` is the contract's own shape, read strictly. */
    #[test]
    fn set_pairs_are_the_contracts_shape_in_its_own_names() {
        let ask = Ask::from_fields(&[
            "memoryGib=20",
            "cpus=null",
            "privileged=false",
            "gpu=true",
            "swapGib=4",
        ])
        .unwrap();
        assert_eq!(
            ask,
            Ask {
                memory: Some("20g".into()),
                cpus: Some(String::new()),
                privileged: Some(false),
                gpus: Some(true),
                swap: Some("4g".into()),
            }
        );
        // `swapGib=null` is the contract's "back to the default", as on the two caps.
        assert_eq!(
            Ask::from_fields(&["swapGib=null"]).unwrap(),
            Ask {
                swap: Some(String::new()),
                ..Ask::default()
            }
        );
        assert!(Ask::from_fields(&["swapGib=2"]).unwrap().swap_only());
        assert!(!Ask::from_fields(&["swapGib=2", "cpus=4"])
            .unwrap()
            .swap_only());
        assert_eq!(
            Ask::from_fields(&["cpus=4"]).unwrap(),
            Ask {
                cpus: Some("4".into()),
                ..Ask::default()
            }
        );
    }

    #[test]
    fn set_refuses_what_it_does_not_know_rather_than_dropping_it() {
        for refused in [
            &["diskGib=4"][..],
            &["swapGib=0"],
            &["swapGib=1.5"],
            &["memoryGib=0"],
            &["memoryGib=1.5"],
            &["memoryGib=\"12g\""],
            &["gpu=on"],
            &["gpu"],
            &["cpus=2", "cpus=4"],
        ] {
            assert!(
                Ask::from_fields(refused).is_err(),
                "{refused:?} was accepted"
            );
        }
    }

    /* THE SWAP: its default, and how it rides a run line whatever the image's run contract knows. */
    #[test]
    fn the_default_swap_is_a_quarter_of_the_cap_between_one_and_four_gib() {
        let gib = 1024 * 1024 * 1024;
        // The same table as @intentic/sandbox-run's defaultSandboxSwapGib test.
        for (cap_gib, swap_gib) in [
            (1, 1),
            (4, 1),
            (5, 2),
            (7, 2),
            (8, 2),
            (12, 3),
            (13, 4),
            (18, 4),
            (64, 4),
        ] {
            assert_eq!(default_swap_gib(cap_gib * gib), swap_gib, "{cap_gib} GiB");
        }
        // An unmeasured or tiny cap still gets a GiB: a cgroup with no swap livelocks rather than meeting its OOM.
        assert_eq!(default_swap_gib(0), 1);
        assert_eq!(default_swap_gib(512 * 1024 * 1024), 1);
    }

    #[test]
    fn a_recreate_hands_the_contract_the_swap_it_applies_and_only_that() {
        let env = b"SANDBOX_MEMORY=12g\0SANDBOX_SWAP=2g\0HOST_SSH_KEY=a\nb\0".to_vec();
        assert_eq!(swap_in_env_nul(&env).as_deref(), Some("2g"));
        let changed = with_swap_env(&env, Some("4g"));
        assert_eq!(swap_in_env_nul(&changed).as_deref(), Some("4g"));
        assert_eq!(
            changed,
            b"SANDBOX_MEMORY=12g\0HOST_SSH_KEY=a\nb\0SANDBOX_SWAP=4g\0".to_vec()
        );
        // Back to the default is no variable at all, never an empty one.
        let cleared = with_swap_env(&env, None);
        assert_eq!(swap_in_env_nul(&cleared), None);
        assert!(!String::from_utf8_lossy(&cleared).contains("SANDBOX_SWAP"));
        assert_eq!(swap_in_env_nul(b"SANDBOX_SWAP=\0"), None);
    }

    #[test]
    fn ic_stamps_the_swap_only_on_a_run_line_the_contract_left_it_off() {
        let line = |pairs: &[&str]| -> Vec<String> {
            let mut argv = vec!["run".to_string(), "-d".to_string()];
            for pair in pairs {
                argv.extend(["-e".to_string(), pair.to_string()]);
            }
            argv.push("img:1".to_string());
            argv
        };
        // An image whose contract predates SANDBOX_SWAP dropped it: ic puts it back.
        assert_eq!(
            swap_stamp(&line(&["SANDBOX_MEMORY=12g"]), Some("4g")),
            vec!["-e", "SANDBOX_SWAP=4g"]
        );
        // One that replays it carried it already: a second copy would be a variable named twice.
        assert!(swap_stamp(&line(&["SANDBOX_SWAP=4g"]), Some("4g")).is_empty());
        // Nothing asked, nothing stamped: the sandbox derives the default from its cap.
        assert!(swap_stamp(&line(&[]), None).is_empty());
        assert!(swap_stamp(&line(&[]), Some(" ")).is_empty());
    }

    #[test]
    fn a_swap_alone_is_told_apart_from_a_change_that_needs_a_restart() {
        let running = shape(Some("12g"), None, false, false);
        let swapped = Shape {
            swap: Some("4g".into()),
            ..running.clone()
        };
        assert!(running.differs_only_in_swap(&swapped));
        assert!(!running.differs_only_in_swap(&running));
        let resized = Shape {
            memory: Some("16g".into()),
            ..swapped.clone()
        };
        assert!(!running.differs_only_in_swap(&resized));
        for bad in ["4", "0g", "1.5g", "4G"] {
            assert!(
                Shape {
                    swap: Some(bad.into()),
                    ..Shape::default()
                }
                .check_spelling()
                .is_err(),
                "{bad}"
            );
        }
    }
}
