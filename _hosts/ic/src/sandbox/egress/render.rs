use super::facts::{Fence, Net, PRIVATE_V4, PRIVATE_V6};
use super::policy::{Port, Protocol};

/* THE RULES, AS TEXT FOR ONE `nft -f`. Pure: what goes in is decided elsewhere (mod.rs), and every ruleset is a golden.

ONE TABLE, `inet intentic_egress`, never Docker's chains. Inside it each fenced sandbox owns a block of objects named by
its id (sha256 of the slug, 12 hex): two base chains, `sbx_<id>_forward` on the forward hook (to the LAN and the
internet) and `sbx_<id>_input` on the input hook (to the host's own addresses, which on Windows include every WSL
distro's services at the bridge gateway), a regular chain `sbx_<id>_refuse` that counts and rejects, and four dynamic
sets that remember for an hour what was refused. One transaction replaces a sandbox's chains whole (`add` then `delete`
then the new block, so a missing chain is no error), and keeps its sets, so the counts survive every reapply.

WHY PER SANDBOX RATHER THAN THE TABLE WHOLE. On a Windows PC, ic on Windows and ic in a WSL distro drive the same engine,
and each holds the policies of the sandboxes it keeps (side.rs) in its own home. A whole-table replace by one side would
drop the other side's fences until that side's next round. Replacing only one's own sandboxes' objects, in one
transaction that either all lands or none of it does, keeps both. The table goes once no sandbox has a chain in it.

REJECT, NEVER DROP: a fenced connection fails at once, not after a timeout an agent would sit through. TCP gets a reset
(ECONNREFUSED, immediately, and never rate-limited by the kernel); everything else gets ICMP administratively-prohibited
(`icmpx`, the right type for either family), which says what happened. ICMP errors are rate-limited per destination, so
TCP, by far the most common protocol here, is not left to them. */

pub const TABLE: &str = "inet intentic_egress";
/// Before Docker's own filter chains, which sit at `filter`.
const PRIORITY: &str = "filter - 10";
/// How long a refused destination is remembered, and how many are.
const MEMORY: &str = "1h";
const MEMORY_SIZE: u32 = 4096;

/// A sandbox's id in the table: sha256 of its slug, 12 hex. Pure.
pub fn id(slug: &str) -> String {
    crate::util::sha256_hex(slug.as_bytes())[..12].to_string()
}

/// The four sets of refused destinations, by family and whether the protocol has ports.
pub const SETS: [(&str, &str); 4] = [
    ("b4p", "ipv4_addr . inet_proto . inet_service"),
    ("b4o", "ipv4_addr . inet_proto"),
    ("b6p", "ipv6_addr . inet_proto . inet_service"),
    ("b6o", "ipv6_addr . inet_proto"),
];

/// One way through, with its destinations resolved to addresses (a name's as the host resolved it; `host` as a flag).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Way {
    /// What the entry said, for the comment above its rules.
    pub to: String,
    pub nets: Vec<Net>,
    pub host: bool,
    pub ports: Option<Vec<Port>>,
    pub protocol: Option<Protocol>,
}

/// Everything one fenced sandbox's rules are made of.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sandbox {
    pub slug: String,
    pub fence: Fence,
    /// The machine's neverAllow, resolved; refused before any way through.
    pub never: Vec<Net>,
    pub never_host: bool,
    /// The resolvers DNS reaches across the fence (only private ones need a rule).
    pub resolvers: Vec<Net>,
    pub ways: Vec<Way>,
}

/// What one transaction does to one sandbox's objects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Fence(Sandbox),
    /// Take the chains and sets of the sandbox with this id out: it is open now, or gone.
    Remove(String),
}

fn set_of(nets: &[&Net]) -> String {
    let nets = super::facts::minimal(nets);
    let items: Vec<&str> = nets.iter().map(|net| net.text.as_str()).collect();
    format!("{{ {} }}", items.join(", "))
}

fn family(nets: &[Net], v6: bool) -> Vec<&Net> {
    nets.iter().filter(|net| net.v6 == v6).collect()
}

fn ports_of(ports: &[Port]) -> String {
    let items: Vec<String> = ports.iter().map(|port| port.nft()).collect();
    format!("{{ {} }}", items.join(", "))
}

/// The protocol-and-port part of a way through, empty for every protocol and port. Pure.
fn service(ports: Option<&[Port]>, protocol: Option<Protocol>) -> String {
    match (protocol, ports) {
        (None, None) => String::new(),
        (None, Some(ports)) => format!(" meta l4proto {{ tcp, udp }} th dport {}", ports_of(ports)),
        (Some(protocol), None) => format!(" meta l4proto {}", protocol.word()),
        (Some(protocol), Some(ports)) => format!(" {} dport {}", protocol.word(), ports_of(ports)),
    }
}

/// `ip daddr {…}<rest>` and `ip6 daddr {…}<rest>` for the families `nets` holds. Pure.
fn by_daddr(out: &mut Vec<String>, nets: &[Net], rest: &str) {
    for (v6, word) in [(false, "ip"), (true, "ip6")] {
        let nets = family(nets, v6);
        if !nets.is_empty() {
            out.push(format!("{word} daddr {}{rest}", set_of(&nets)));
        }
    }
}

/// The first rules of both base chains: anything not from this sandbox goes back to the hook untouched, and so does
/// anything from a sibling sharing its network. Pure.
fn dispatch(out: &mut Vec<String>, fence: &Fence) {
    for (v6, word, proto) in [(false, "ip", "ipv4"), (true, "ip6", "ipv6")] {
        let nets = family(&fence.sources, v6);
        if nets.is_empty() {
            out.push(format!("meta nfproto {proto} return"));
            continue;
        }
        out.push(format!("{word} saddr != {} return", set_of(&nets)));
        let siblings = family(&fence.excluded, v6);
        if !siblings.is_empty() {
            out.push(format!("{word} saddr {} return", set_of(&siblings)));
        }
    }
}

/// What every chain allows first: replies to connections already allowed (and to ones made TO the sandbox), and
/// IPv6 neighbour discovery, without which the sandbox could not find its own gateway.
const SETTLED: [&str; 2] = [
    "ct state established,related accept",
    "icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, nd-router-advert, nd-redirect } accept",
];

fn refuse(id: &str) -> String {
    format!("goto sbx_{id}_refuse")
}

/// The neverAllow and resolver rules both base chains share. Pure.
fn before_ways(out: &mut Vec<String>, sandbox: &Sandbox, id: &str) {
    if !sandbox.never.is_empty() {
        out.push("# the machine's neverAllow, before any way through".to_string());
        by_daddr(out, &sandbox.never, &format!(" {}", refuse(id)));
    }
    if !sandbox.resolvers.is_empty() {
        out.push("# DNS to the resolvers docker forwards to".to_string());
        by_daddr(
            out,
            &sandbox.resolvers,
            " meta l4proto { tcp, udp } th dport 53 accept",
        );
    }
}

/// The ways through to addresses (every entry but `host`). Pure.
fn ways_to_addresses(out: &mut Vec<String>, ways: &[Way]) {
    for way in ways.iter().filter(|way| !way.host) {
        out.push(format!("# allow {}", way.to));
        if way.nets.is_empty() {
            out.push(format!(
                "# {} did not resolve on the host: nothing opened",
                way.to
            ));
            continue;
        }
        by_daddr(
            out,
            &way.nets,
            &format!("{} accept", service(way.ports.as_deref(), way.protocol)),
        );
    }
}

fn chain(name: &str, hook: Option<&str>, rules: &[String]) -> String {
    let mut text = format!("\tchain {name} {{\n");
    if let Some(hook) = hook {
        text.push_str(&format!(
            "\t\ttype filter hook {hook} priority {PRIORITY}; policy accept;\n"
        ));
    }
    for rule in rules {
        text.push_str(&format!("\t\t{rule}\n"));
    }
    text.push_str("\t}\n");
    text
}

/// The block that declares one sandbox's sets and chains. Pure.
fn block(sandbox: &Sandbox) -> String {
    let id = id(&sandbox.slug);
    let mut text = format!(
        "\t# {} ({} match)\n",
        sandbox.slug,
        sandbox.fence.matched.word()
    );
    for (suffix, key) in SETS {
        text.push_str(&format!(
            "\tset sbx_{id}_{suffix} {{ type {key}; flags dynamic,timeout; timeout {MEMORY}; size {MEMORY_SIZE}; counter; }}\n"
        ));
    }
    let refuse_rules = vec![
        format!("meta l4proto {{ tcp, udp }} update @sbx_{id}_b4p {{ ip daddr . meta l4proto . th dport }}"),
        format!("meta l4proto != {{ tcp, udp }} update @sbx_{id}_b4o {{ ip daddr . meta l4proto }}"),
        format!("meta l4proto {{ tcp, udp }} update @sbx_{id}_b6p {{ ip6 daddr . meta l4proto . th dport }}"),
        format!("meta l4proto != {{ tcp, udp }} update @sbx_{id}_b6o {{ ip6 daddr . meta l4proto }}"),
        "meta l4proto tcp reject with tcp reset".to_string(),
        "reject with icmpx admin-prohibited".to_string(),
    ];
    text.push_str(&chain(&format!("sbx_{id}_refuse"), None, &refuse_rules));

    // Forward: to the LAN and the internet.
    let mut forward: Vec<String> = Vec::new();
    dispatch(&mut forward, &sandbox.fence);
    forward.extend(SETTLED.iter().map(|rule| rule.to_string()));
    if !sandbox.fence.peers.is_empty() {
        forward.push("# peers on its own networks".to_string());
        by_daddr(&mut forward, &sandbox.fence.peers, " accept");
    }
    before_ways(&mut forward, sandbox, &id);
    ways_to_addresses(&mut forward, &sandbox.ways);
    forward.push("# internet-only: every private range".to_string());
    // The contract's own spellings, as they are (facts.rs holds them to its golden).
    let private = |ranges: &[&str], v6: bool| -> Vec<Net> {
        ranges
            .iter()
            .map(|range| Net {
                v6,
                text: range.to_string(),
            })
            .collect()
    };
    let mut private_nets = private(&PRIVATE_V4, false);
    private_nets.extend(private(&PRIVATE_V6, true));
    by_daddr(&mut forward, &private_nets, &format!(" {}", refuse(&id)));
    text.push_str(&chain(
        &format!("sbx_{id}_forward"),
        Some("forward"),
        &forward,
    ));

    // Input: to the host itself, whatever its addresses are.
    // The host's own traffic to its own bridge address arrives on loopback, from an address inside a network-mode
    // sandbox's subnet (the gateway): never the sandbox's.
    let mut input: Vec<String> = vec!["iifname \"lo\" return".to_string()];
    dispatch(&mut input, &sandbox.fence);
    input.extend(SETTLED.iter().map(|rule| rule.to_string()));
    before_ways(&mut input, sandbox, &id);
    ways_to_addresses(&mut input, &sandbox.ways);
    for way in sandbox.ways.iter().filter(|way| way.host) {
        out_host(&mut input, way, sandbox.never_host);
    }
    input.push("# the host itself".to_string());
    input.push(refuse(&id));
    text.push_str(&chain(&format!("sbx_{id}_input"), Some("input"), &input));
    text
}

fn out_host(out: &mut Vec<String>, way: &Way, never_host: bool) {
    out.push(format!("# allow {}", way.to));
    if never_host {
        out.push("# the machine's neverAllow names the host: nothing opened".to_string());
        return;
    }
    let service = service(way.ports.as_deref(), way.protocol);
    out.push(
        format!("{} accept", service.trim_start())
            .trim_start()
            .to_string(),
    );
}

/// The lines that take a sandbox's chains out, whether or not they exist: `add` makes a missing one, `delete` takes
/// it out, and both are one transaction with what follows. Referencing chains go before the one they jump to.
fn take_out_chains(text: &mut String, id: &str) {
    for (name, hook) in [
        ("forward", Some("forward")),
        ("input", Some("input")),
        ("refuse", None),
    ] {
        let spec = match hook {
            Some(hook) => {
                format!(" {{ type filter hook {hook} priority {PRIORITY}; policy accept; }}")
            }
            None => String::new(),
        };
        text.push_str(&format!("add chain {TABLE} sbx_{id}_{name}{spec}\n"));
        text.push_str(&format!("delete chain {TABLE} sbx_{id}_{name}\n"));
    }
}

/// One transaction for `changes`: every change lands, or none does. `drop_table` takes the whole table out instead
/// of leaving it empty (the caller read that no other sandbox has chains in it). Pure.
pub fn transaction(changes: &[Change], drop_table: bool) -> String {
    let mut text =
        format!("# ic sandbox egress: one transaction, all or nothing\nadd table {TABLE}\n");
    if drop_table {
        text.push_str(&format!("delete table {TABLE}\n"));
        return text;
    }
    for change in changes {
        let id = match change {
            Change::Fence(sandbox) => id(&sandbox.slug),
            Change::Remove(id) => id.clone(),
        };
        take_out_chains(&mut text, &id);
        if let Change::Remove(_) = change {
            for (suffix, key) in SETS {
                text.push_str(&format!(
                    "add set {TABLE} sbx_{id}_{suffix} {{ type {key}; flags dynamic,timeout; timeout {MEMORY}; size {MEMORY_SIZE}; counter; }}\n"
                ));
                text.push_str(&format!("delete set {TABLE} sbx_{id}_{suffix}\n"));
            }
        }
    }
    let blocks: Vec<String> = changes
        .iter()
        .filter_map(|change| match change {
            Change::Fence(sandbox) => Some(block(sandbox)),
            Change::Remove(_) => None,
        })
        .collect();
    if !blocks.is_empty() {
        text.push_str(&format!("table {TABLE} {{\n{}}}\n", blocks.join("\n")));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::super::facts::Match;
    use super::*;

    fn nets(list: &[&str]) -> Vec<Net> {
        list.iter().map(|text| Net::parse(text).unwrap()).collect()
    }

    fn network_mode() -> Sandbox {
        Sandbox {
            slug: "sandbox-2e8d89d75865".into(),
            fence: Fence {
                matched: Match::Network,
                sources: nets(&["172.20.0.0/16", "fd00:20::/64"]),
                excluded: vec![],
                peers: nets(&["172.20.0.0/16", "fd00:20::/64"]),
                networks: vec![],
            },
            never: nets(&["192.168.1.1"]),
            never_host: false,
            resolvers: nets(&["192.168.1.1"]),
            ways: vec![
                Way {
                    to: "nas.lan".into(),
                    nets: nets(&["192.168.1.20", "fd00::20"]),
                    host: false,
                    ports: Some(vec![Port::One(445), Port::Range(8000, 8100)]),
                    protocol: Some(Protocol::Tcp),
                },
                Way {
                    to: "10.8.0.0/24".into(),
                    nets: nets(&["10.8.0.0/24"]),
                    host: false,
                    ports: None,
                    protocol: None,
                },
                Way {
                    to: "printer".into(),
                    nets: vec![],
                    host: false,
                    ports: Some(vec![Port::One(631)]),
                    protocol: None,
                },
                Way {
                    to: "host".into(),
                    nets: vec![],
                    host: true,
                    ports: Some(vec![Port::One(11434)]),
                    protocol: None,
                },
            ],
        }
    }

    fn address_mode() -> Sandbox {
        Sandbox {
            slug: "work".into(),
            fence: Fence {
                matched: Match::Address,
                sources: nets(&["172.30.0.0/16"]),
                excluded: nets(&["172.30.0.3", "172.30.0.4"]),
                peers: nets(&["172.30.0.0/16"]),
                networks: vec!["work_default".into()],
            },
            never: vec![],
            never_host: true,
            resolvers: vec![],
            ways: vec![Way {
                to: "host".into(),
                nets: vec![],
                host: true,
                ports: None,
                protocol: None,
            }],
        }
    }

    /// The goldens: set IC_EGRESS_GOLDEN=write to write them again after a deliberate change, then read the diff.
    fn golden(name: &str, actual: &str) {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/sandbox/egress/golden")
            .join(name);
        if std::env::var("IC_EGRESS_GOLDEN").as_deref() == Ok("write") {
            std::fs::write(&path, actual).unwrap();
        }
        let expected = std::fs::read_to_string(&path).unwrap_or_default();
        assert_eq!(
            actual,
            expected,
            "{} differs from what was rendered",
            path.display()
        );
    }

    #[test]
    fn a_network_mode_sandbox_renders_as_its_golden() {
        golden(
            "network.nft",
            &transaction(&[Change::Fence(network_mode())], false),
        );
    }

    #[test]
    fn an_address_mode_sandbox_renders_as_its_golden() {
        golden(
            "address.nft",
            &transaction(&[Change::Fence(address_mode())], false),
        );
    }

    #[test]
    fn taking_a_sandbox_out_and_dropping_the_table_render_as_their_goldens() {
        golden(
            "remove.nft",
            &transaction(&[Change::Remove(id("work"))], false),
        );
        assert_eq!(
            transaction(&[], true),
            "# ic sandbox egress: one transaction, all or nothing\nadd table inet intentic_egress\ndelete table inet intentic_egress\n"
        );
    }

    #[test]
    fn the_order_is_settled_peers_never_allow_ways_then_the_private_ranges() {
        let text = transaction(&[Change::Fence(network_mode())], false);
        let forward = text
            .split("\tchain sbx_")
            .skip(1)
            .find(|chain| chain.contains("hook forward"))
            .unwrap();
        let at = |needle: &str| {
            forward
                .find(needle)
                .unwrap_or_else(|| panic!("{needle} missing"))
        };
        assert!(at("saddr !=") < at("ct state established"));
        assert!(at("ct state established") < at("# peers"));
        assert!(at("# peers") < at("# the machine's neverAllow"));
        assert!(at("# the machine's neverAllow") < at("# allow nas.lan"));
        assert!(at("# allow nas.lan") < at("# internet-only"));
        // A sandbox's chains are all replaced in the one transaction, its sets kept for their counts.
        assert!(!text.contains("delete set"));
        assert!(
            text.find("delete chain").unwrap() < text.find("table inet intentic_egress {").unwrap()
        );
        // No word nftables reserves is a chain's whole name.
        for reserved in ["chain fwd ", "chain input ", "chain forward "] {
            assert!(!text.contains(reserved), "{reserved}");
        }
    }

    #[test]
    fn a_ways_service_is_spelled_for_each_combination() {
        assert_eq!(service(None, None), "");
        assert_eq!(
            service(Some(&[Port::One(53)]), None),
            " meta l4proto { tcp, udp } th dport { 53 }"
        );
        assert_eq!(service(None, Some(Protocol::Udp)), " meta l4proto udp");
        assert_eq!(
            service(Some(&[Port::Range(1, 9)]), Some(Protocol::Tcp)),
            " tcp dport { 1-9 }"
        );
    }

    #[test]
    fn a_sandbox_id_is_stable_and_short() {
        assert_eq!(id("work"), id("work"));
        assert_ne!(id("work"), id("work2"));
        assert_eq!(id("work").len(), 12);
    }
}
