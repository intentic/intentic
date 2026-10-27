use std::net::Ipv6Addr;

use serde_json::{json, Map, Value};

use crate::util::{bail, Result};

/* A SANDBOX'S EGRESS POLICY, read the way the sandbox contract writes it (_shared/sandbox-contract/src/schemas/egress.ts):
strictly, a field ic does not know refused rather than dropped, and spelled back in the contract's one canonical form, so
the revision ic reports is the same for every way of writing the same policy. */

/// The contract's `EgressProfileSchema`, tightest last.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Profile {
    Open,
    InternetOnly,
}

impl Profile {
    pub fn word(self) -> &'static str {
        match self {
            Profile::Open => "open",
            Profile::InternetOnly => "internet-only",
        }
    }

    pub fn from_word(word: &str) -> Option<Profile> {
        match word {
            "open" => Some(Profile::Open),
            "internet-only" => Some(Profile::InternetOnly),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Protocol {
    Tcp,
    Udp,
}

impl Protocol {
    pub fn word(self) -> &'static str {
        match self {
            Protocol::Tcp => "tcp",
            Protocol::Udp => "udp",
        }
    }
}

/// One port, or an inclusive range `from-to` (from < to).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Port {
    One(u16),
    Range(u16, u16),
}

impl Port {
    fn start(self) -> u16 {
        match self {
            Port::One(port) | Port::Range(port, _) => port,
        }
    }

    /// The contract's spelling: a number, or the string `from-to`.
    fn json(self) -> Value {
        match self {
            Port::One(port) => json!(port),
            Port::Range(from, to) => json!(format!("{from}-{to}")),
        }
    }

    /// `String(port)` in the contract: what ports are deduplicated and tie-broken by.
    fn text(self) -> String {
        match self {
            Port::One(port) => port.to_string(),
            Port::Range(from, to) => format!("{from}-{to}"),
        }
    }

    /// nftables' spelling.
    pub fn nft(self) -> String {
        self.text()
    }
}

/// What a destination is (`egressDestinationKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    V4,
    V6,
    Host,
    Name,
}

/// One way through `internet-only` (`EgressAllowSchema`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Allow {
    pub to: String,
    pub ports: Option<Vec<Port>>,
    pub protocol: Option<Protocol>,
    pub note: Option<String>,
    pub from: Option<String>,
}

/// A sandbox's whole policy (`EgressPolicySchema`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub profile: Profile,
    pub allow: Vec<Allow>,
}

impl Policy {
    /// `OPEN_EGRESS`: what a sandbox ic holds nothing for is read as.
    pub fn open() -> Policy {
        Policy {
            profile: Profile::Open,
            allow: Vec::new(),
        }
    }
}

/// The contract's `EGRESS_HOST`.
pub const HOST: &str = "host";
/// The contract's `EGRESS_NO_REVISION`.
pub const NO_REVISION: &str = "none";

/* ---- Destinations ---- */

/// A dotted quad as zod's `z.ipv4()` takes it: four decimal octets, no leading zeros. Pure.
fn is_ipv4(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
                && part.parse::<u16>().is_ok_and(|octet| octet <= 255)
        })
}

fn prefix_len(text: &str, max: u8) -> bool {
    !text.is_empty()
        && text.len() <= 3
        && text.bytes().all(|byte| byte.is_ascii_digit())
        && (text.len() == 1 || !text.starts_with('0'))
        && text.parse::<u8>().is_ok_and(|len| len <= max)
}

fn is_ipv6(text: &str) -> bool {
    !text.contains('%') && text.parse::<Ipv6Addr>().is_ok()
}

/// A hostname as the contract's HOSTNAME pattern takes it: dot-separated labels of letters, digits and hyphens, none
/// starting or ending with a hyphen, at most 253 characters, an optional trailing dot. Pure.
fn is_hostname(text: &str) -> bool {
    if text.is_empty() || text.len() > 253 || !text.is_ascii() {
        return false;
    }
    let body = text.strip_suffix('.').unwrap_or(text);
    !body.is_empty()
        && body.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

/// `egressDestinationKind`: which kind a destination is, or None when it is none. Pure.
pub fn destination_kind(value: &str) -> Option<Kind> {
    if value == HOST {
        return Some(Kind::Host);
    }
    let (address, prefix) = match value.split_once('/') {
        Some((address, prefix)) => (address, Some(prefix)),
        None => (value, None),
    };
    if is_ipv4(address) && prefix.is_none_or(|prefix| prefix_len(prefix, 32)) {
        return Some(Kind::V4);
    }
    if is_ipv6(address) && prefix.is_none_or(|prefix| prefix_len(prefix, 128)) {
        return Some(Kind::V6);
    }
    // A dotted quad that failed as an address (300.1.1.1) is a typo, never a name.
    if value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.' || byte == b'/')
        || value.contains(':')
    {
        return None;
    }
    is_hostname(value).then_some(Kind::Name)
}

/// `EgressDestinationSchema`: trimmed, 1-253 characters, of a kind. Pure.
fn destination(field: &str, value: &Value) -> Result<String> {
    let Some(text) = value.as_str() else {
        bail!("{field} is a string; got {value}.");
    };
    let text = text.trim();
    if text.is_empty() || text.chars().count() > 253 || destination_kind(text).is_none() {
        bail!(
            "{field} `{text}` is not a destination: a destination is an address (192.168.1.20), a prefix (192.168.1.0/24, fd00::/8), a hostname (nas.lan) or the word host."
        );
    }
    Ok(text.to_string())
}

/* ---- The strict read ---- */

fn object<'a>(value: &'a Value, what: &str, known: &[&str]) -> Result<&'a Map<String, Value>> {
    let Some(map) = value.as_object() else {
        bail!("{what} is a JSON object; got {value}.");
    };
    if let Some(unknown) = map.keys().find(|key| !known.contains(&key.as_str())) {
        bail!(
            "this ic does not know the field `{unknown}` of {what} (it knows {}): update ic.",
            known.join(", ")
        );
    }
    Ok(map)
}

fn text_field(map: &Map<String, Value>, field: &str, what: &str) -> Result<Option<String>> {
    match map.get(field) {
        None => Ok(None),
        Some(Value::String(text)) if text.chars().count() <= 200 => Ok(Some(text.clone())),
        Some(Value::String(_)) => bail!("{what}'s {field} is at most 200 characters."),
        Some(other) => bail!("{what}'s {field} is a string; got {other}."),
    }
}

fn port(value: &Value) -> Result<Port> {
    if let Some(number) = value.as_u64() {
        return match u16::try_from(number) {
            Ok(port) if port >= 1 => Ok(Port::One(port)),
            _ => bail!("a port is 1-65535; got {number}."),
        };
    }
    let range = value.as_str().and_then(|text| {
        let (from, to) = text.split_once('-')?;
        let digits = |part: &str| {
            (!part.is_empty() && part.len() <= 5 && part.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| part.parse::<u32>().ok())
                .flatten()
        };
        Some((digits(from)?, digits(to)?))
    });
    match range {
        Some((from, to)) if from >= 1 && to <= 65535 && from < to => {
            Ok(Port::Range(from as u16, to as u16))
        }
        _ => bail!("a port is a number 1-65535, or a range running upwards spelled FROM-TO like 8000-8100; got {value}."),
    }
}

fn allow(value: &Value, index: usize) -> Result<Allow> {
    let what = format!("allow[{index}]");
    let map = object(value, &what, &["to", "ports", "protocol", "note", "from"])?;
    let Some(to) = map.get("to") else {
        bail!("{what} has no `to`.");
    };
    let to = destination(&format!("{what}.to"), to)?;
    let ports = match map.get("ports") {
        None => None,
        Some(Value::Array(ports)) if (1..=32).contains(&ports.len()) => {
            Some(ports.iter().map(port).collect::<Result<Vec<Port>>>()?)
        }
        Some(_) => bail!("{what}.ports is a list of 1 to 32 ports."),
    };
    let protocol = match map.get("protocol") {
        None => None,
        Some(value) => match value.as_str() {
            Some("tcp") => Some(Protocol::Tcp),
            Some("udp") => Some(Protocol::Udp),
            _ => bail!("{what}.protocol is tcp or udp (absent for both); got {value}."),
        },
    };
    Ok(Allow {
        to,
        ports,
        protocol,
        note: text_field(map, "note", &what)?,
        from: text_field(map, "from", &what)?,
    })
}

/// A policy from its JSON, as strictly as the contract's `EgressPolicySchema` reads it. Pure.
pub fn parse(text: &str) -> Result<Policy> {
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(err) => bail!("--policy takes the policy as JSON ({err})."),
    };
    let map = object(&value, "the policy", &["profile", "allow"])?;
    let profile = match map
        .get("profile")
        .and_then(Value::as_str)
        .and_then(Profile::from_word)
    {
        Some(profile) => profile,
        None => bail!("the policy's profile is open or internet-only."),
    };
    let allow = match map.get("allow") {
        Some(Value::Array(entries)) if entries.len() <= 64 => entries
            .iter()
            .enumerate()
            .map(|(index, entry)| allow(entry, index))
            .collect::<Result<Vec<Allow>>>()?,
        Some(Value::Array(_)) => bail!("the policy's allow holds at most 64 entries."),
        _ => bail!("the policy's allow is a list (empty for none)."),
    };
    Ok(Policy { profile, allow })
}

/* ---- The one spelling (`canonicalEgressPolicy`) ---- */

fn canonical_allow(entry: &Allow) -> Allow {
    let to = entry.to.trim().to_lowercase();
    let to = to.strip_suffix('.').map(str::to_string).unwrap_or(to);
    let ports = entry.ports.as_ref().map(|ports| {
        let mut once: Vec<Port> = Vec::new();
        for port in ports {
            if !once.iter().any(|seen| seen.text() == port.text()) {
                once.push(*port);
            }
        }
        once.sort_by(|a, b| {
            a.start()
                .cmp(&b.start())
                .then_with(|| a.text().cmp(&b.text()))
        });
        once
    });
    Allow {
        to,
        ports,
        protocol: entry.protocol,
        note: entry.note.clone(),
        from: entry.from.clone(),
    }
}

/// One entry as the contract's JSON spells it, keys in its order: to, from, note, ports, protocol. Written out by
/// hand: serde_json's maps keep their keys sorted, and the canonical text is JSON.stringify's, in insertion order.
fn allow_text(entry: &Allow) -> String {
    let string = |text: &str| Value::String(text.to_string()).to_string();
    let mut fields = vec![format!("\"to\":{}", string(&entry.to))];
    if let Some(from) = &entry.from {
        fields.push(format!("\"from\":{}", string(from)));
    }
    if let Some(note) = &entry.note {
        fields.push(format!("\"note\":{}", string(note)));
    }
    if let Some(ports) = &entry.ports {
        let ports: Vec<String> = ports.iter().map(|port| port.json().to_string()).collect();
        fields.push(format!("\"ports\":[{}]", ports.join(",")));
    }
    if let Some(protocol) = entry.protocol {
        fields.push(format!("\"protocol\":{}", string(protocol.word())));
    }
    format!("{{{}}}", fields.join(","))
}

/// One entry as a JSON value (for a status, where key order does not matter).
fn allow_json(entry: &Allow) -> Value {
    serde_json::from_str(&allow_text(entry)).expect("an entry's own text is JSON")
}

/// The policy in its one form: destinations lower-cased, ports deduplicated and in order, entries deduplicated and in
/// order of their text. Pure.
pub fn canonical(policy: &Policy) -> Policy {
    let mut entries: Vec<(String, Allow)> = Vec::new();
    for entry in policy.allow.iter().map(canonical_allow) {
        let text = allow_text(&entry);
        match entries.iter_mut().find(|(seen, _)| *seen == text) {
            // The contract's Map keeps the last of equal texts, which is the same text.
            Some(slot) => slot.1 = entry,
            None => entries.push((text, entry)),
        }
    }
    entries.sort_by(|(a, _), (b, _)| a.cmp(b));
    Policy {
        profile: policy.profile,
        allow: entries.into_iter().map(|(_, entry)| entry).collect(),
    }
}

/// `canonicalEgressPolicyJson`: `{"allow":[...],"profile":"..."}`. Pure.
pub fn canonical_json(policy: &Policy) -> String {
    let canonical = canonical(policy);
    let entries: Vec<String> = canonical.allow.iter().map(allow_text).collect();
    format!(
        "{{\"allow\":[{}],\"profile\":{}}}",
        entries.join(","),
        Value::String(canonical.profile.word().to_string())
    )
}

/// The policy as the contract's JSON, as it stands (not re-spelled).
pub fn to_json(policy: &Policy) -> Value {
    json!({
        "allow": policy.allow.iter().map(allow_json).collect::<Vec<Value>>(),
        "profile": policy.profile.word(),
    })
}

/// The revision of a held policy: sha256 of its canonical JSON, OPAQUE to everyone but ic; `none` when nothing is
/// held. Pure.
pub fn revision(held: Option<&Policy>) -> String {
    match held {
        Some(policy) => crate::util::sha256_hex(canonical_json(policy).as_bytes()),
        None => NO_REVISION.to_string(),
    }
}

/* ---- The machine's own word (`EgressBaselineSchema`) ---- */

/// What the machine says over every sandbox on it: a sandbox's profile is lifted to at least `minimum`, and
/// `never_allow` is refused before any sandbox's allow is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Baseline {
    pub minimum: Profile,
    pub never_allow: Vec<String>,
}

impl Default for Baseline {
    fn default() -> Baseline {
        Baseline {
            minimum: Profile::Open,
            never_allow: Vec::new(),
        }
    }
}

/// A baseline laid over another key by key, with a sentence for every value not understood. A minimum nobody knows is
/// `internet-only`, said: a typo in the machine's word must never quietly leave a sandbox looser. A neverAllow entry
/// that is no destination is said and left out. Pure.
pub fn baseline_over(mut base: Baseline, name: &str, layer: &Value) -> (Baseline, Vec<String>) {
    let mut said = Vec::new();
    let Some(map) = layer.as_object() else {
        said.push(format!(
            "{name}: egress is not a JSON object; it was ignored."
        ));
        return (base, said);
    };
    for key in map
        .keys()
        .filter(|key| !["minimum", "neverAllow"].contains(&key.as_str()))
    {
        said.push(format!(
            "{name}: egress.{key} is not a setting this ic knows; it was ignored."
        ));
    }
    if let Some(value) = map.get("minimum") {
        base.minimum = match value.as_str().and_then(Profile::from_word) {
            Some(profile) => profile,
            None => {
                said.push(format!(
                    "{name}: egress.minimum {value} is not open or internet-only; using internet-only."
                ));
                Profile::InternetOnly
            }
        };
    }
    if let Some(value) = map.get("neverAllow") {
        match value.as_array() {
            Some(entries) => {
                base.never_allow = entries
                    .iter()
                    .filter_map(|entry| match destination("egress.neverAllow", entry) {
                        Ok(to) => Some(to.to_lowercase()),
                        Err(err) => {
                            said.push(format!("{name}: {}", err.0));
                            None
                        }
                    })
                    .take(64)
                    .collect();
            }
            None => said.push(format!(
                "{name}: egress.neverAllow is not a list; it was ignored."
            )),
        }
    }
    (base, said)
}

/// A sandbox's policy after the machine's word: its profile lifted to the minimum. Pure.
pub fn effective_profile(held: &Policy, baseline: &Baseline) -> Profile {
    held.profile.max(baseline.minimum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_destination_is_an_address_a_prefix_a_hostname_or_the_host_as_the_contract_says() {
        // The contract's own cases (egress.test.ts).
        assert_eq!(destination_kind("192.168.1.20"), Some(Kind::V4));
        assert_eq!(destination_kind("10.0.0.0/8"), Some(Kind::V4));
        assert_eq!(destination_kind("fd00::/8"), Some(Kind::V6));
        assert_eq!(destination_kind("fe80::1"), Some(Kind::V6));
        assert_eq!(destination_kind("host"), Some(Kind::Host));
        assert_eq!(destination_kind("nas.lan"), Some(Kind::Name));
        assert_eq!(destination_kind("printer"), Some(Kind::Name));
        for none in [
            "300.1.1.1",
            "10.0.0.0/40",
            "fd00::zz",
            "-bad.lan",
            "01.2.3.4",
            "1.2.3",
            "fe80::1%eth0",
            "",
        ] {
            assert_eq!(destination_kind(none), None, "{none}");
        }
    }

    #[test]
    fn a_policy_is_read_strictly_and_a_field_ic_does_not_know_is_refused() {
        let policy = parse(r#"{"profile":"internet-only","allow":[{"to":" NAS.lan. ","ports":[445,"8000-8100"],"protocol":"tcp","note":"the NAS","from":"owner"}]}"#).unwrap();
        assert_eq!(policy.profile, Profile::InternetOnly);
        assert_eq!(policy.allow[0].to, "NAS.lan.");
        assert_eq!(
            policy.allow[0].ports,
            Some(vec![Port::One(445), Port::Range(8000, 8100)])
        );
        for refused in [
            r#"{"profile":"internet-only","allow":[],"extra":true}"#,
            r#"{"profile":"internet-only","allow":[{"to":"host","why":"x"}]}"#,
            r#"{"profile":"closed","allow":[]}"#,
            r#"{"profile":"open"}"#,
            r#"{"profile":"open","allow":[{"to":"300.1.1.1"}]}"#,
            r#"{"profile":"open","allow":[{"to":"host","ports":[]}]}"#,
            r#"{"profile":"open","allow":[{"to":"host","ports":[0]}]}"#,
            r#"{"profile":"open","allow":[{"to":"host","ports":["9-3"]}]}"#,
            r#"{"profile":"open","allow":[{"to":"host","ports":["80"]}]}"#,
            r#"{"profile":"open","allow":[{"to":"host","protocol":"icmp"}]}"#,
            r#"{"profile":"open","allow":[{"ports":[80]}]}"#,
            "not json",
        ] {
            assert!(parse(refused).is_err(), "{refused} was accepted");
        }
    }

    #[test]
    fn the_canonical_spelling_is_the_contracts() {
        let policy = parse(r#"{"profile":"internet-only","allow":[{"to":"NAS.lan.","protocol":"tcp","ports":[8000,"20-30",445,445]},{"to":"host"},{"to":"host"}]}"#).unwrap();
        // Byte for byte what canonicalEgressPolicyJson spells for the same policy.
        assert_eq!(
            canonical_json(&policy),
            r#"{"allow":[{"to":"host"},{"to":"nas.lan","ports":["20-30",445,8000],"protocol":"tcp"}],"profile":"internet-only"}"#
        );
        // Two spellings of one policy share a revision; another policy has another.
        let same = parse(r#"{"allow":[{"to":"host"},{"ports":[445,"20-30",8000],"to":"nas.lan","protocol":"tcp"}],"profile":"internet-only"}"#).unwrap();
        assert_eq!(revision(Some(&policy)), revision(Some(&same)));
        assert_ne!(revision(Some(&policy)), revision(Some(&Policy::open())));
        assert_eq!(revision(None), "none");
        assert_eq!(revision(Some(&policy)).len(), 64);
    }

    #[test]
    fn the_baseline_lifts_and_a_typo_in_it_is_the_tighter_reading_said() {
        let (baseline, said) = baseline_over(
            Baseline::default(),
            "os.json",
            &json!({ "minimum": "internet-only", "neverAllow": ["192.168.1.1", "nope..", "host"] }),
        );
        assert_eq!(baseline.minimum, Profile::InternetOnly);
        assert_eq!(
            baseline.never_allow,
            vec!["192.168.1.1".to_string(), "host".to_string()]
        );
        assert_eq!(said.len(), 1);
        assert_eq!(
            effective_profile(&Policy::open(), &baseline),
            Profile::InternetOnly
        );
        let (typo, said) = baseline_over(
            Baseline::default(),
            "egress.json",
            &json!({ "minimum": "internet" }),
        );
        assert_eq!(typo.minimum, Profile::InternetOnly);
        assert_eq!(said.len(), 1);
        assert_eq!(
            effective_profile(&Policy::open(), &Baseline::default()),
            Profile::Open
        );
    }
}
