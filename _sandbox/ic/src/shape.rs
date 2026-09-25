use crate::util::{bail, Result};

/* A SANDBOX'S SHAPE: the owner's own ask for its share of this machine, whole. Every field is a value; nothing here means "leave it". */

/// The owner's ask as a container carries it (SANDBOX_MEMORY, SANDBOX_CPUS and their own SANDBOX_RUNTIME tokens), or
/// as it is saved for the next restart (the channel record's `desired_*` keys). ABSOLUTE on purpose: a saved delta
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
}

impl Ask {
    /// Nothing asked: every field "leave it".
    pub fn is_empty(&self) -> bool {
        self.memory.is_none()
            && self.cpus.is_none()
            && self.privileged.is_none()
            && self.gpus.is_none()
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
        }
    }

    /// The whole shape as an ask that names every field, which is what a recreate seeds the contract with.
    pub fn as_ask(&self) -> Ask {
        Ask {
            memory: Some(self.memory.clone().unwrap_or_default()),
            cpus: Some(self.cpus.clone().unwrap_or_default()),
            privileged: Some(self.privileged),
            gpus: Some(self.gpus),
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
        format!(
            "{memory}, {cpus}, privileged {}, gpus {}",
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
        })
    }

    /* THE CHANNEL RECORD'S SPELLING — one key per field, all four or none (record.rs). */

    /// The four record values, `default` standing for a cap left to the contract (an empty value would be an empty key).
    pub fn to_record(&self) -> [String; 4] {
        let cap = |value: &Option<String>| value.clone().unwrap_or_else(|| "default".to_string());
        let switch = |on: bool| (if on { "on" } else { "off" }).to_string();
        [
            cap(&self.memory),
            cap(&self.cpus),
            switch(self.privileged),
            switch(self.gpus),
        ]
    }

    /// The shape back from its four record values, or None when any is missing or unreadable: a half-written shape
    /// is not one to restart onto.
    pub fn from_record(
        memory: Option<&str>,
        cpus: Option<&str>,
        privileged: Option<&str>,
        gpus: Option<&str>,
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

    fn shape(memory: Option<&str>, cpus: Option<&str>, privileged: bool, gpus: bool) -> Shape {
        Shape {
            memory: memory.map(str::to_string),
            cpus: cpus.map(str::to_string),
            privileged,
            gpus,
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
        let saved = shape(Some("20g"), None, false, true);
        let [memory, cpus, privileged, gpus] = saved.to_record();
        assert_eq!(
            [&memory, &cpus, &privileged, &gpus],
            ["20g", "default", "off", "on"]
        );
        assert_eq!(
            Shape::from_record(Some(&memory), Some(&cpus), Some(&privileged), Some(&gpus)),
            Some(saved)
        );
        assert_eq!(
            Shape::from_record(Some("20g"), None, Some("off"), Some("on")),
            None
        );
        assert_eq!(
            Shape::from_record(Some("20g"), Some("default"), Some("maybe"), Some("on")),
            None
        );
        assert_eq!(
            Shape::from_record(Some("lots"), Some("default"), Some("off"), Some("on")),
            None
        );
    }

    #[test]
    fn the_json_is_the_contracts_vocabulary() {
        assert_eq!(
            shape(Some("20g"), Some("4"), true, false).to_json(),
            serde_json::json!({ "memoryGib": 20, "cpus": 4, "privileged": true, "gpu": false })
        );
        assert_eq!(
            Shape::default().to_json(),
            serde_json::json!({ "memoryGib": null, "cpus": null, "privileged": false, "gpu": false })
        );
    }

    #[test]
    fn a_shape_is_described_in_the_order_the_form_shows_it() {
        assert_eq!(
            shape(Some("20g"), None, false, true).describe(),
            "memory 20g, cpus default, privileged off, gpus on"
        );
    }
}
