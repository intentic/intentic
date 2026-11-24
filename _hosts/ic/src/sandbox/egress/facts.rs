use std::net::{Ipv4Addr, Ipv6Addr};

use serde_json::Value;

/* WHAT THE FENCE IS DRAWN AROUND, read off docker's own answers: a sandbox's container and the networks it is on, and the
resolvers its DNS goes through. Pure over the JSON `docker inspect` / `docker network inspect` print, so every rule of the
match is a test. */

/// One address or prefix of one family, spelled the way nftables takes it: a prefix with its host bits cleared.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Net {
    pub v6: bool,
    pub text: String,
}

impl Net {
    /// An address (`10.0.0.5`, `fd00::1`) or a prefix (`10.0.0.0/8`); None for anything else. Pure.
    pub fn parse(value: &str) -> Option<Net> {
        let (address, prefix) = match value.trim().split_once('/') {
            Some((address, prefix)) => (address, Some(prefix.parse::<u8>().ok()?)),
            None => (value.trim(), None),
        };
        if let Ok(v4) = address.parse::<Ipv4Addr>() {
            return Some(match prefix {
                None | Some(32) => Net {
                    v6: false,
                    text: v4.to_string(),
                },
                Some(len) if len < 32 => {
                    let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
                    Net {
                        v6: false,
                        text: format!("{}/{len}", Ipv4Addr::from(u32::from(v4) & mask)),
                    }
                }
                Some(_) => return None,
            });
        }
        let v6 = address.parse::<Ipv6Addr>().ok()?;
        Some(match prefix {
            None | Some(128) => Net {
                v6: true,
                text: v6.to_string(),
            },
            Some(len) if len < 128 => {
                let mask = if len == 0 {
                    0
                } else {
                    u128::MAX << (128 - len)
                };
                Net {
                    v6: true,
                    text: format!("{}/{len}", Ipv6Addr::from(u128::from(v6) & mask)),
                }
            }
            Some(_) => return None,
        })
    }

    /// The prefix length: 32 or 128 for one address.
    pub fn len(&self) -> u32 {
        match self.text.split_once('/') {
            Some((_, len)) => len.parse().unwrap_or(0),
            None => {
                if self.v6 {
                    128
                } else {
                    32
                }
            }
        }
    }

    /// Whether `range` holds all of this address or prefix. Pure.
    pub fn inside(&self, range: &Net) -> bool {
        self.len() >= range.len() && self.within(range)
    }

    /// Whether this address (or the first address of this prefix) lies in `range`. Pure.
    pub fn within(&self, range: &Net) -> bool {
        if self.v6 != range.v6 {
            return false;
        }
        let address = self.text.split('/').next().unwrap_or_default();
        let (base, len) = match range.text.split_once('/') {
            Some((base, len)) => (base, len.parse::<u32>().unwrap_or(0)),
            None => (range.text.as_str(), if range.v6 { 128 } else { 32 }),
        };
        if self.v6 {
            let (Ok(address), Ok(base)) = (address.parse::<Ipv6Addr>(), base.parse::<Ipv6Addr>())
            else {
                return false;
            };
            let mask = if len == 0 {
                0
            } else {
                u128::MAX << (128 - len)
            };
            u128::from(address) & mask == u128::from(base) & mask
        } else {
            let (Ok(address), Ok(base)) = (address.parse::<Ipv4Addr>(), base.parse::<Ipv4Addr>())
            else {
                return false;
            };
            let mask = if len == 0 { 0 } else { u32::MAX << (32 - len) };
            u32::from(address) & mask == u32::from(base) & mask
        }
    }
}

/// The nets with every one another of them already holds left out: nftables refuses overlapping intervals in one
/// set. Pure.
pub fn minimal(nets: &[&Net]) -> Vec<Net> {
    let mut kept: Vec<Net> = Vec::new();
    for (index, net) in nets.iter().enumerate() {
        let held_elsewhere = nets.iter().enumerate().any(|(other, range)| {
            other != index && net.inside(range) && (*net != *range || other < index)
        });
        if !held_elsewhere {
            kept.push((*net).clone());
        }
    }
    kept
}

/// The ranges `internet-only` refuses: the contract's EGRESS_PRIVATE_V4/V6, held to its golden by a test below.
pub const PRIVATE_V4: [&str; 14] = [
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
];
pub const PRIVATE_V6: [&str; 8] = [
    "::/128",
    "::1/128",
    "::ffff:0:0/96",
    "64:ff9b:1::/48",
    "fc00::/7",
    "fe80::/10",
    "fec0::/10",
    "ff00::/8",
];

/// Whether an address lies in a range `internet-only` refuses. Pure.
pub fn is_private(net: &Net) -> bool {
    let ranges: &[&str] = if net.v6 { &PRIVATE_V6 } else { &PRIVATE_V4 };
    ranges
        .iter()
        .filter_map(|range| Net::parse(range))
        .any(|range| net.within(&range))
}

/// One network a container is attached to, and the addresses docker gave it there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attachment {
    pub network: String,
    pub addresses: Vec<Net>,
}

/// What the fence needs of a sandbox's container, from its `docker inspect` object.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct Container {
    pub running: bool,
    /// `HostConfig.NetworkMode`: a network's name, `bridge`, `host`, `none` or `container:<id>`.
    pub network_mode: String,
    pub attachments: Vec<Attachment>,
    pub privileged: bool,
    /// `HostConfig.Runtime`: `runc` unless the run line named another (`kata` under Intentic OS's isolation).
    pub runtime: String,
    /// `HostConfig.Dns`: the resolvers its run line named, which docker's own resolver forwards to.
    pub dns: Vec<Net>,
    /// The image id it runs: what the helper that writes the rules is started from.
    pub image: String,
}

/// A container's facts from its inspect object. Pure.
pub fn container(inspected: &Value) -> Container {
    let host = &inspected["HostConfig"];
    let mut attachments: Vec<Attachment> = inspected["NetworkSettings"]["Networks"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(network, settings)| Attachment {
            network: network.clone(),
            addresses: ["IPAddress", "GlobalIPv6Address"]
                .iter()
                .filter_map(|key| settings[*key].as_str())
                .filter(|address| !address.is_empty())
                .filter_map(Net::parse)
                .collect(),
        })
        .collect();
    attachments.sort_by(|a, b| a.network.cmp(&b.network));
    Container {
        running: inspected["State"]["Running"] == true,
        network_mode: host["NetworkMode"].as_str().unwrap_or_default().to_string(),
        attachments,
        privileged: host["Privileged"] == true,
        runtime: host["Runtime"].as_str().unwrap_or("runc").to_string(),
        dns: host["Dns"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(Net::parse)
            .collect(),
        image: inspected["Image"].as_str().unwrap_or_default().to_string(),
    }
}

/// One docker network: its subnets, and whether ic made it for this sandbox.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    pub name: String,
    pub subnets: Vec<Net>,
    /// The sandbox its `dev.intentic.sandbox` label names, when it is ic's own (`dev.intentic.kind=network`).
    pub ours_for: Option<String>,
    /// Whether it carries any `dev.intentic.*` label at all: a network from before the labels has none.
    pub labelled: bool,
    /// The containers on it now, by name, with their addresses there (`Containers`: only those connected, which is
    /// every running one).
    pub members: Vec<(String, Vec<Net>)>,
}

/// A network's facts from its `docker network inspect` object. Pure.
pub fn network(inspected: &Value) -> Network {
    let labels = inspected["Labels"].as_object();
    let label = |key: &str| {
        labels
            .and_then(|labels| labels.get(key))
            .and_then(Value::as_str)
    };
    let ours_for = (label(crate::sandbox::labels::KIND)
        == Some(crate::sandbox::labels::Kind::Network.wire()))
    .then(|| label(crate::sandbox::labels::SANDBOX).map(str::to_string))
    .flatten();
    Network {
        name: inspected["Name"].as_str().unwrap_or_default().to_string(),
        subnets: inspected["IPAM"]["Config"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|config| config["Subnet"].as_str())
            .filter_map(Net::parse)
            .collect(),
        ours_for,
        labelled: labels
            .is_some_and(|labels| labels.keys().any(|key| key.starts_with("dev.intentic."))),
        members: members(&inspected["Containers"]),
    }
}

/// A network inspect's `Containers`, as names and addresses, sorted by name. Docker writes each address with the
/// network's prefix length (`172.30.0.5/16`): only the address is the container's. Pure.
fn members(containers: &Value) -> Vec<(String, Vec<Net>)> {
    let mut members: Vec<(String, Vec<Net>)> = containers
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(_, member)| {
            let name = member["Name"].as_str()?.trim_start_matches('/').to_string();
            let addresses = ["IPv4Address", "IPv6Address"]
                .iter()
                .filter_map(|key| member[*key].as_str())
                .filter_map(|address| address.split('/').next())
                .filter(|address| !address.is_empty())
                .filter_map(Net::parse)
                .collect();
            Some((name, addresses))
        })
        .collect();
    members.sort_by(|a, b| a.0.cmp(&b.0));
    members
}

/// How a sandbox is told apart on the host (the contract's `match`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Match {
    /// ic's own network for the sandbox: fenced as a whole, from the first packet of anything on it.
    Network,
    /// A network something else made (Compose): the network's subnet less the addresses of every other container on
    /// it, so the sandbox is fenced from its first packet at any address it is given, and its siblings are not.
    Address,
}

impl Match {
    pub fn word(self) -> &'static str {
        match self {
            Match::Network => "network",
            Match::Address => "address",
        }
    }
}

/// What the rules for one sandbox are drawn around: the sources whose traffic is fenced, less the addresses of the
/// other containers that share its networks, and the peers on those networks, which it may always reach (the deploy
/// target beside it, Compose's sibling services).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fence {
    pub matched: Match,
    pub sources: Vec<Net>,
    /// Addresses inside `sources` that are not the sandbox's: its siblings on a shared network, never fenced.
    pub excluded: Vec<Net>,
    pub peers: Vec<Net>,
    /// The shared networks (not ic's own) it is fenced on by subnet, remembered with what ic applied, so a sandbox whose
    /// container was removed (Compose's recreate) stays fenced on them until it comes back: [`fence`] with no container.
    pub networks: Vec<String>,
}

/// Why no fence can be drawn yet, or at all.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoFence {
    /// Nothing to match yet: no container and no network of ic's, or a stopped container off ic's network.
    NotYet(String),
    /// Something no rule on the host can tell apart: the host's own network, another container's namespace.
    Never(String),
}

/// Whether `network` is the one ic made for `slug`: its name, and its labels naming this sandbox (or, from before the
/// labels, none at all). Pure.
pub fn is_ours(network: &Network, slug: &str) -> bool {
    network.name == crate::sandbox::trash::network(slug)
        && match &network.ours_for {
            Some(owner) => owner == slug,
            None => !network.labelled,
        }
}

fn push_unique(into: &mut Vec<Net>, nets: impl IntoIterator<Item = Net>) {
    for net in nets {
        if !into.contains(&net) {
            into.push(net);
        }
    }
}

/// THE MATCH: network mode when the sandbox is on the network ic made for it (or, before its container exists, when
/// that network does), address mode otherwise. `networks` are the inspected networks the container is attached to,
/// plus ic's own for the slug when it exists. Pure.
pub fn fence(
    slug: &str,
    container: Option<&Container>,
    networks: &[Network],
) -> Result<Fence, NoFence> {
    let ours = networks.iter().find(|network| is_ours(network, slug));
    let own = [
        crate::sandbox::container_of(slug),
        crate::sandbox::parked_of(slug),
    ];
    /* NO CONTAINER: ic's own network as a whole, and every shared network ic fenced it on before (the caller passes
    those it remembers), by subnet less every container on it now. A Compose recreate removes the container before it
    makes the new one: the sandbox's next address is inside a subnet already fenced, so its first packet is too. */
    let Some(container) = container else {
        let mut sources: Vec<Net> = Vec::new();
        let mut excluded: Vec<Net> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        let mut matched: Option<Match> = None;
        if let Some(ours) = ours.filter(|ours| !ours.subnets.is_empty()) {
            push_unique(&mut sources, ours.subnets.iter().cloned());
            matched = Some(Match::Network);
        }
        for network in networks
            .iter()
            .filter(|network| !is_ours(network, slug) && !network.subnets.is_empty())
        {
            push_unique(&mut sources, network.subnets.iter().cloned());
            push_unique(
                &mut excluded,
                network
                    .members
                    .iter()
                    .filter(|(name, _)| !own.contains(name))
                    .flat_map(|(_, addresses)| addresses.iter().cloned()),
            );
            names.push(network.name.clone());
            matched.get_or_insert(Match::Address);
        }
        return match matched {
            Some(matched) => Ok(Fence {
                matched,
                peers: sources.clone(),
                sources,
                excluded,
                networks: names,
            }),
            None => Err(NoFence::NotYet(
                "the sandbox has no container yet".to_string(),
            )),
        };
    };
    let mode = container.network_mode.as_str();
    if mode == "host" {
        return Err(NoFence::Never(
            "it runs on the host's own network, where no rule on the host can tell its traffic from the host's".to_string(),
        ));
    }
    if let Some(other) = mode.strip_prefix("container:") {
        return Err(NoFence::Never(format!(
            "it shares the network of another container ({other}), whose traffic no rule can tell from its own"
        )));
    }
    let mut peers: Vec<Net> = Vec::new();
    for attachment in &container.attachments {
        if let Some(network) = networks
            .iter()
            .find(|network| network.name == attachment.network)
        {
            push_unique(&mut peers, network.subnets.iter().cloned());
        }
    }
    let on_ours = ours.filter(|ours| {
        container
            .attachments
            .iter()
            .any(|attachment| attachment.network == ours.name)
    });
    let mut sources: Vec<Net> = Vec::new();
    let mut excluded: Vec<Net> = Vec::new();
    let matched = match on_ours {
        Some(ours) if !ours.subnets.is_empty() => {
            push_unique(&mut sources, ours.subnets.iter().cloned());
            Match::Network
        }
        _ => Match::Address,
    };
    /* EVERY OTHER NETWORK IT IS ON, FAIL SAFE: the network's subnet, less the addresses of the containers on it that are
    not this sandbox. A sandbox recreated onto a new address is fenced from its first packet (it is in the subnet and
    in no exclusion); what can go wrong instead is a sibling that starts after the rules were drawn being fenced from
    private destinations until `--follow` or the watch adds it to the exclusions. Never from its own peers (the subnet
    is a peer of every fenced chain, and the sibling's packets to it are not this sandbox's to judge) nor the internet. */
    let mut names: Vec<String> = Vec::new();
    let own_addresses: Vec<&Net> = container
        .attachments
        .iter()
        .flat_map(|attachment| attachment.addresses.iter())
        .collect();
    for attachment in &container.attachments {
        if matched == Match::Network && on_ours.is_some_and(|ours| ours.name == attachment.network)
        {
            continue;
        }
        match networks
            .iter()
            .find(|network| network.name == attachment.network)
            .filter(|network| !network.subnets.is_empty())
        {
            Some(network) => {
                push_unique(&mut sources, network.subnets.iter().cloned());
                let siblings = network
                    .members
                    .iter()
                    .filter(|(name, _)| !own.contains(name))
                    .flat_map(|(_, addresses)| addresses.iter().cloned())
                    .filter(|address| !own_addresses.contains(&address));
                push_unique(&mut excluded, siblings);
                names.push(network.name.clone());
            }
            // A network docker would not describe: the container's own addresses there, as docker gave them.
            None => push_unique(&mut sources, attachment.addresses.iter().cloned()),
        }
    }
    if sources.is_empty() {
        return Err(NoFence::NotYet(if container.running {
            "docker reports no network with an address range for it".to_string()
        } else {
            "it is stopped on no network ic can read, so there is nothing to match until it starts"
                .to_string()
        }));
    }
    Ok(Fence {
        matched,
        sources,
        excluded,
        peers,
        networks: names,
    })
}

/// Whether the rules are advisory: a privileged container under runc is the host's root and can step around any rule
/// on the host; under Kata it has a kernel of its own. Pure.
pub fn advisory(container: &Container) -> bool {
    container.privileged && !container.runtime.contains("kata")
}

/// The resolvers a `resolv.conf` names that DNS from a container reaches over the network: its `nameserver` lines and
/// the `# ExtServers: [...]` docker writes for its own resolver, without loopback ones and without those docker
/// forwards to from the host's namespace (`host(…)`), which never cross the fence. Pure.
pub fn resolvers(resolv_conf: &str) -> Vec<Net> {
    let mut found: Vec<Net> = Vec::new();
    for line in resolv_conf.lines().map(str::trim) {
        if let Some(server) = line.strip_prefix("nameserver") {
            push_unique(&mut found, Net::parse(server.trim()));
        } else if let Some(list) = line.strip_prefix("# ExtServers:") {
            let list = list.trim().trim_start_matches('[').trim_end_matches(']');
            for server in list.split_whitespace() {
                if server.starts_with("host(") {
                    continue;
                }
                push_unique(&mut found, Net::parse(server));
            }
        }
    }
    let loopback = [Net::parse("127.0.0.0/8"), Net::parse("::1")];
    found.retain(|net| !loopback.iter().flatten().any(|range| net.within(range)));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn net(text: &str) -> Net {
        Net::parse(text).unwrap()
    }

    #[test]
    fn the_private_ranges_are_the_contracts_golden() {
        let golden: Value = serde_json::from_str(include_str!(
            "../../../../../_shared/sandbox-contract/golden/egress-private.json"
        ))
        .unwrap();
        assert_eq!(golden["v4"], json!(PRIVATE_V4));
        assert_eq!(golden["v6"], json!(PRIVATE_V6));
        // Every one reads as a prefix, and none has host bits set.
        for range in PRIVATE_V4.iter().chain(PRIVATE_V6.iter()) {
            assert!(net(range).within(&net(range)), "{range}");
        }
        for range in PRIVATE_V4 {
            assert_eq!(net(range).text, range);
        }
    }

    #[test]
    fn a_set_keeps_only_what_no_other_member_holds() {
        let nets = [
            net("10.0.0.0/8"),
            net("10.1.0.0/16"),
            net("10.1.2.3"),
            net("192.168.1.1"),
            net("192.168.1.1"),
            net("fd00::/8"),
        ];
        let refs: Vec<&Net> = nets.iter().collect();
        assert_eq!(
            minimal(&refs),
            vec![net("10.0.0.0/8"), net("192.168.1.1"), net("fd00::/8")]
        );
    }

    #[test]
    fn a_prefix_loses_its_host_bits_and_containment_is_per_family() {
        assert_eq!(net("192.168.1.5/24").text, "192.168.1.0/24");
        assert_eq!(net("fd00::1/8").text, "fd00::/8");
        assert_eq!(net("10.0.0.1/32").text, "10.0.0.1");
        assert_eq!(Net::parse("10.0.0.1/33"), None);
        assert!(is_private(&net("192.168.1.20")));
        assert!(is_private(&net("169.254.169.254")));
        assert!(is_private(&net("::ffff:10.0.0.1")));
        assert!(is_private(&net("fe80::1")));
        assert!(!is_private(&net("1.1.1.1")));
        assert!(!is_private(&net("2606:4700::1111")));
        assert!(!net("10.0.0.1").within(&net("fd00::/8")));
    }

    fn inspected(mode: &str, networks: Value, privileged: bool, runtime: &str) -> Value {
        json!({
            "Image": "sha256:abc",
            "State": { "Running": true },
            "HostConfig": { "NetworkMode": mode, "Privileged": privileged, "Runtime": runtime, "Dns": ["192.168.1.1"] },
            "NetworkSettings": { "Networks": networks },
        })
    }

    fn ours(slug: &str, subnets: &[&str]) -> Network {
        network(&json!({
            "Name": format!("intentic-workspace-{slug}"),
            "Labels": { "dev.intentic.sandbox": slug, "dev.intentic.kind": "network" },
            "IPAM": { "Config": subnets.iter().map(|subnet| json!({ "Subnet": subnet })).collect::<Vec<_>>() },
        }))
    }

    #[test]
    fn on_its_own_network_a_sandbox_is_fenced_by_the_network_and_anything_else_by_its_addresses() {
        let own = ours("work", &["172.20.0.0/16", "fd00:20::/64"]);
        let shared = network(&json!({
            "Name": "proj_default",
            "Labels": { "com.docker.compose.project": "proj" },
            "IPAM": { "Config": [{ "Subnet": "172.30.0.0/16" }] },
            "Containers": {
                "a1": { "Name": "intentic-sandbox-work", "IPv4Address": "172.30.0.5/16", "IPv6Address": "" },
                "b2": { "Name": "proj-db-1", "IPv4Address": "172.30.0.3/16", "IPv6Address": "" },
                "c3": { "Name": "proj-web-1", "IPv4Address": "172.30.0.4/16", "IPv6Address": "fd30::4/64" },
                "d4": { "Name": "intentic-sandbox-work.previous", "IPv4Address": "172.30.0.8/16", "IPv6Address": "" },
            },
        }));
        let box_ = container(&inspected(
            "intentic-workspace-work",
            json!({
                "intentic-workspace-work": { "IPAddress": "172.20.0.2", "GlobalIPv6Address": "fd00:20::2" },
                "proj_default": { "IPAddress": "172.30.0.9", "GlobalIPv6Address": "" },
            }),
            false,
            "runc",
        ));
        let fence_ = fence("work", Some(&box_), &[own.clone(), shared.clone()]).unwrap();
        assert_eq!(fence_.matched, Match::Network);
        // Its own network as a whole, and the other network it joined less the containers there that are not it.
        assert_eq!(
            fence_.sources,
            vec![
                net("172.20.0.0/16"),
                net("fd00:20::/64"),
                net("172.30.0.0/16")
            ]
        );
        assert_eq!(
            fence_.peers,
            vec![
                net("172.20.0.0/16"),
                net("fd00:20::/64"),
                net("172.30.0.0/16")
            ]
        );

        // Compose made the network: its subnet less every other container on it (the parked copy of this sandbox is
        // its own, so not a sibling), so a sibling service is never fenced and a recreated sandbox always is.
        let composed = container(&inspected(
            "proj_default",
            json!({ "proj_default": { "IPAddress": "172.30.0.5" } }),
            false,
            "runc",
        ));
        let fence_ = fence("work", Some(&composed), std::slice::from_ref(&shared)).unwrap();
        assert_eq!(fence_.matched, Match::Address);
        assert_eq!(fence_.sources, vec![net("172.30.0.0/16")]);
        assert_eq!(
            fence_.excluded,
            vec![net("172.30.0.3"), net("172.30.0.4"), net("fd30::4")]
        );
        assert_eq!(fence_.peers, vec![net("172.30.0.0/16")]);
        // Recreated onto an address a sibling's list still names (docker reused it): never excluded as a sibling.
        let reused = container(&inspected(
            "proj_default",
            json!({ "proj_default": { "IPAddress": "172.30.0.3" } }),
            false,
            "runc",
        ));
        let fence_ = fence("work", Some(&reused), std::slice::from_ref(&shared)).unwrap();
        assert!(!fence_.excluded.contains(&net("172.30.0.3")));
        // With no sibling at all, the rule is the subnet alone.
        let alone = Network {
            members: vec![("intentic-sandbox-work".into(), vec![net("172.30.0.5")])],
            ..shared.clone()
        };
        let fence_ = fence("work", Some(&composed), std::slice::from_ref(&alone)).unwrap();
        assert_eq!(fence_.sources, vec![net("172.30.0.0/16")]);
        assert!(fence_.excluded.is_empty());
        // A network docker would not describe: the container's own address, as before.
        let fence_ = fence("work", Some(&composed), &[]).unwrap();
        assert_eq!(fence_.sources, vec![net("172.30.0.5")]);

        // A network named like ic's but labelled for another sandbox is not this one's.
        let theirs = Network {
            ours_for: Some("other".into()),
            ..ours("work", &["172.20.0.0/16"])
        };
        assert!(!is_ours(&theirs, "work"));
        // One from before the labels is ic's by its name.
        let older = Network {
            ours_for: None,
            labelled: false,
            ..ours("work", &["172.20.0.0/16"])
        };
        assert!(is_ours(&older, "work"));
    }

    #[test]
    fn a_removed_compose_sandbox_stays_fenced_on_the_shared_network_it_was_fenced_on() {
        // Compose's recreate: the container is gone, the network it was on is remembered (passed by the caller), and
        // everything on it now is a sibling, so whatever address the next container gets is inside the fence.
        let shared = Network {
            name: "proj_default".into(),
            subnets: vec![net("172.30.0.0/16")],
            members: vec![
                ("proj-db-1".into(), vec![net("172.30.0.3")]),
                (crate::sandbox::parked_of("work"), vec![net("172.30.0.9")]),
            ],
            ours_for: None,
            labelled: false,
        };
        let fence_ = fence("work", None, std::slice::from_ref(&shared)).unwrap();
        assert_eq!(fence_.matched, Match::Address);
        assert_eq!(fence_.sources, vec![net("172.30.0.0/16")]);
        assert_eq!(fence_.peers, vec![net("172.30.0.0/16")]);
        // Its own parked copy is never a sibling; the database is.
        assert_eq!(fence_.excluded, vec![net("172.30.0.3")]);
        assert_eq!(fence_.networks, vec!["proj_default".to_string()]);
        // On ic's own network too, both are fenced, and the match is the network's.
        let fence_ = fence("work", None, &[ours("work", &["172.20.0.0/16"]), shared]).unwrap();
        assert_eq!(fence_.matched, Match::Network);
        assert_eq!(
            fence_.sources,
            vec![net("172.20.0.0/16"), net("172.30.0.0/16")]
        );
    }

    #[test]
    fn before_its_container_exists_ics_network_is_fenced_already_and_nothing_else_can_be() {
        let own = ours("work", &["172.20.0.0/16"]);
        assert_eq!(fence("work", None, &[own]).unwrap().matched, Match::Network);
        assert!(matches!(fence("work", None, &[]), Err(NoFence::NotYet(_))));
        // A stopped Compose container has no address yet, and is fenced already by its network's subnet.
        let stopped = Container {
            network_mode: "proj_default".into(),
            attachments: vec![Attachment {
                network: "proj_default".into(),
                addresses: vec![],
            }],
            ..Container::default()
        };
        assert!(matches!(
            fence("work", Some(&stopped), &[]),
            Err(NoFence::NotYet(_))
        ));
        let shared = Network {
            name: "proj_default".into(),
            subnets: vec![net("172.30.0.0/16")],
            ours_for: None,
            labelled: false,
            members: vec![],
        };
        let fence_ = fence("work", Some(&stopped), &[shared]).unwrap();
        assert_eq!(fence_.matched, Match::Address);
        assert_eq!(fence_.sources, vec![net("172.30.0.0/16")]);
        let host = Container {
            network_mode: "host".into(),
            ..Container::default()
        };
        assert!(matches!(
            fence("work", Some(&host), &[]),
            Err(NoFence::Never(_))
        ));
    }

    #[test]
    fn privileged_on_runc_is_advisory_and_under_kata_it_is_not() {
        let privileged = container(&inspected("bridge", json!({}), true, "runc"));
        assert!(advisory(&privileged));
        assert!(!advisory(&container(&inspected(
            "bridge",
            json!({}),
            true,
            "kata"
        ))));
        assert!(!advisory(&container(&inspected(
            "bridge",
            json!({}),
            false,
            "runc"
        ))));
        assert_eq!(privileged.dns, vec![net("192.168.1.1")]);
        assert_eq!(privileged.image, "sha256:abc");
    }

    #[test]
    fn the_resolvers_are_the_ones_dns_crosses_the_fence_to() {
        let conf = "# Generated by Docker Engine.\nnameserver 127.0.0.11\nsearch lan\noptions ndots:0\n\n# Based on host file: '/etc/resolv.conf' (internal resolver)\n# ExtServers: [192.168.1.1 host(127.0.0.53) 1.1.1.1]\n";
        assert_eq!(resolvers(conf), vec![net("192.168.1.1"), net("1.1.1.1")]);
        assert_eq!(
            resolvers("nameserver 10.255.255.254\nnameserver ::1\n"),
            vec![net("10.255.255.254")]
        );
    }
}
