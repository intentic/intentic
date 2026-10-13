mod code;
mod http;
mod page;

use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::json;

use super::{policy, Paths};
use crate::docker;
use crate::sandbox::{listing, now_ms};
use crate::util::{bail, Result};
use page::{Phase, State};

/* FIRST BOOT: TURNING A MACHINE WITH NOTHING ON IT INTO A SANDBOX'S DEVICE. `intentic-pair.service` runs `ic os pair` as
the `intentic` user while the machine has no sandbox, with the console (tty1) as its terminal on the server edition and
`--no-console` on the desktop one, whose screen belongs to the app. It says where to get a setup code (app.intentic.dev,
New sandbox, On my own machine) and takes one from two places at once: a line typed on the console, and a small page
on the local network (http.rs), unless the owner's policy says `pairOnLan: false`. Either may carry the whole setup
command; the code is read out of it (code.rs). The first code to arrive is tried and the others wait: `ic sandbox
connect <code> -y` runs as its own process, so its progress streams to the console and the page line by line, and a
connect that fails leaves this one waiting for another code rather than gone. Success leaves
`/var/lib/intentic-os/paired`, keeps the page saying so for half a minute, and ends. */

/// What `ic os pair` was asked to do.
pub struct Args {
    pub port: u16,
    pub no_lan: bool,
    pub no_console: bool,
}

/// The state every thread here shares.
pub type Shared = Arc<Mutex<State>>;

/// The state, whichever thread panicked while holding it.
pub fn lock(shared: &Shared) -> MutexGuard<'_, State> {
    shared
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What became of a code handed in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Claim {
    /// It is the one tried next.
    Accepted,
    /// Another code is being tried.
    Busy,
    /// The machine is paired already.
    Done,
}

/// Hand in a code from `from` (the console, the page): it becomes the one attempt unless another runs or pairing is
/// over. Changing the state and handing the code on happen under one lock, so two sources never both win.
pub fn claim(shared: &Shared, code: &str, codes: &Sender<String>, from: &str) -> Claim {
    let mut state = lock(shared);
    match state.phase {
        Phase::Pairing => Claim::Busy,
        Phase::Done => Claim::Done,
        Phase::Waiting | Phase::Failed => {
            state.phase = Phase::Pairing;
            state.message = format!("A setup code arrived from {from}; setting up the sandbox. This takes a few minutes.");
            state.log.clear();
            let _ = codes.send(code.to_string());
            Claim::Accepted
        }
    }
}

/// How long the machine's docker may take to answer at first boot before pairing gives up (and systemd starts it again).
const DOCKER_WAIT: Duration = Duration::from_secs(5 * 60);
/// How long one `ic sandbox connect` may run: a first image pull is gigabytes.
const CONNECT_LIMIT: Duration = Duration::from_secs(90 * 60);
/// How long the page keeps saying "paired" before the process ends.
const DONE_LINGER: Duration = Duration::from_secs(30);
/// Tried when the asked port cannot be had, if that was the default.
const FALLBACK_PORT: u16 = 8080;

/// `ic os pair`.
pub fn run(args: Args) -> Result<()> {
    wait_for_docker()?;
    let seen = listing::seen()?;
    if !seen.is_empty() {
        let slugs: Vec<&str> = seen.iter().map(|seen| seen.slug.as_str()).collect();
        crate::ui::done(&format!(
            "This machine already has a sandbox ({}); there is nothing to pair.",
            slugs.join(", ")
        ));
        return Ok(());
    }
    let lan = !args.no_lan && policy::current().pair_on_lan;
    let served = if lan { listen(args.port) } else { None };
    if served.is_none() && args.no_console {
        bail!(
            "{}",
            crate::ui::explain(
                "There is nowhere to take a setup code from.",
                Some(if lan {
                    "the pairing page could not be served, and --no-console turns the console off."
                } else {
                    "the pairing page is off (--no-lan, or pairOnLan: false in /etc/intentic/os.json), and --no-console turns the console off."
                }),
                Some("ic os pair (on the console)"),
            )
        );
    }
    let shared: Shared = Arc::new(Mutex::new(State::waiting()));
    let (codes, arrived) = mpsc::channel::<String>();
    let port = served.as_ref().map(|(_, port)| *port);
    instructions(
        port.map(|port| page_urls(&addresses(), port)),
        !args.no_console,
    );
    if let Some((listener, _)) = served {
        let (shared, codes, hostname) = (shared.clone(), codes.clone(), hostname());
        std::thread::spawn(move || http::serve(listener, hostname, shared, codes));
    }
    if !args.no_console {
        let (shared, codes) = (shared.clone(), codes.clone());
        std::thread::spawn(move || console(std::io::stdin().lock(), &shared, &codes));
    }
    drop(codes);
    for code in arrived {
        say(&lock(&shared).message.clone());
        match connect(&code, &shared) {
            Ok(()) => return paired(&shared, port.is_some()),
            Err(why) => {
                let mut state = lock(&shared);
                state.phase = Phase::Failed;
                state.message =
                    format!("Pairing did not finish: {why} Paste another code to try again.");
                say(&state.message);
            }
        }
    }
    bail!("No setup code can arrive any more: the console closed and no pairing page is served.")
}

/// The machine is paired: say so everywhere, leave the marker, and give the page time to say it too.
fn paired(shared: &Shared, page: bool) -> Result<()> {
    {
        let mut state = lock(shared);
        state.phase = Phase::Done;
        state.message =
            "Paired. This machine runs your sandbox now; open it from app.intentic.dev."
                .to_string();
        say(&state.message);
    }
    let marker = json!({ "pairedAt": now_ms() });
    if let Err(err) = super::write_atomic(&Paths::here().paired(), format!("{marker}\n").as_bytes())
    {
        crate::ui::warn(&format!("the paired marker was not written: {}", err.0));
    }
    if page {
        std::thread::sleep(DONE_LINGER);
    }
    Ok(())
}

/// Docker at first boot may still be starting: wait for it, within a bound.
fn wait_for_docker() -> Result<()> {
    let deadline = Instant::now() + DOCKER_WAIT;
    let mut said = false;
    loop {
        if docker::engine(docker::ENGINE_PROBE).up() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!(
                "Docker did not answer within {} minutes, so this machine cannot be paired yet.",
                DOCKER_WAIT.as_secs() / 60
            );
        }
        if !said {
            say("Waiting for Docker to start…");
            said = true;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// The page's listener on every address: the asked port, or 8080 when the default 80 cannot be had (a unit without the
/// capability to bind it). None, said, when neither can be.
fn listen(port: u16) -> Option<(TcpListener, u16)> {
    match TcpListener::bind(("0.0.0.0", port)) {
        Ok(listener) => return Some((listener, port)),
        Err(err) if port != 80 => {
            crate::ui::warn(&format!(
                "the pairing page could not be served on port {port}: {err}."
            ));
            return None;
        }
        Err(err) => crate::ui::warn(&format!(
            "the pairing page could not be served on port 80 ({err}); trying {FALLBACK_PORT}."
        )),
    }
    match TcpListener::bind(("0.0.0.0", FALLBACK_PORT)) {
        Ok(listener) => Some((listener, FALLBACK_PORT)),
        Err(err) => {
            crate::ui::warn(&format!(
                "the pairing page could not be served on port {FALLBACK_PORT} either: {err}."
            ));
            None
        }
    }
}

/// Where to get a code, and where to put it.
fn instructions(urls: Option<Vec<String>>, console: bool) {
    say("");
    say("Intentic OS: pair this machine with your Intentic account");
    say("");
    say("  1. On any device, open app.intentic.dev, choose New sandbox, then On my own machine.");
    say("     Copy the setup code it shows (or the whole setup command).");
    match (&urls, console) {
        (Some(urls), true) => {
            say("  2. Type the code here and press Enter, or paste it on this machine's page:");
            for url in urls {
                say(&format!("       {url}"));
            }
        }
        (Some(urls), false) => {
            say("  2. Paste it on this machine's page, from a device on the same network:");
            for url in urls {
                say(&format!("       {url}"));
            }
        }
        (None, _) => say("  2. Type the code here and press Enter."),
    }
    say("");
}

/// One line on the pairing console.
fn say(line: &str) {
    // allow(terminal-output): the pairing console's own screen (tty1 at first boot), which a person reads and types into.
    println!("{line}");
}

/// Codes typed on the console, one per line, until it closes.
fn console(input: impl BufRead, shared: &Shared, codes: &Sender<String>) {
    for line in input.lines() {
        let Ok(line) = line else {
            return;
        };
        if line.trim().is_empty() {
            continue;
        }
        match code::setup_code(&line) {
            None => say("That is not a setup code. Type the letters and digits the setup page shows, or paste its command."),
            Some(code) => match claim(shared, &code, codes, "the console") {
                Claim::Accepted => {}
                Claim::Busy => say("A code is being tried already; wait for it to finish."),
                Claim::Done => return,
            },
        }
    }
}

/// `ic sandbox connect <code> -y`, as its own process: each line it prints goes to the console and onto the page. Err
/// is the sentence it stopped on.
fn connect(code: &str, shared: &Shared) -> std::result::Result<(), String> {
    let exe =
        std::env::current_exe().map_err(|err| format!("could not find ic itself ({err})."))?;
    let mut child = Command::new(exe)
        .args(["sandbox", "connect", "-y", "--", code])
        .env(crate::tty::NO_PROMPT, "1")
        .env("INTENTIC_UI", "plain")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start ic sandbox connect ({err})."))?;
    let pumps: Vec<_> = [
        child
            .stdout
            .take()
            .map(|out| Box::new(out) as Box<dyn Read + Send>),
        child
            .stderr
            .take()
            .map(|err| Box::new(err) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    .map(|stream| {
        let shared = shared.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream)
                .lines()
                .map_while(std::result::Result::ok)
            {
                say(&line);
                lock(&shared).push_log(&line);
            }
        })
    })
    .collect();
    let deadline = Instant::now() + CONNECT_LIMIT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(250)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    for pump in pumps {
        let _ = pump.join();
    }
    match status {
        Some(status) if status.success() => Ok(()),
        Some(_) => Err(stopped_on(&lock(shared).log)),
        None => Err(format!(
            "setting the sandbox up took longer than {} minutes and was stopped.",
            CONNECT_LIMIT.as_secs() / 60
        )),
    }
}

/// The sentence a failed connect stopped on: the `problem:` under its last `error:` (a stop that lists what failed
/// heads the list with a line of its own), else that `error:` line, else the last line it printed. Pure.
fn stopped_on(log: &[String]) -> String {
    let error = log
        .iter()
        .rposition(|line| line.trim().starts_with("error:"));
    let line = match error {
        Some(at) => log[at + 1..]
            .iter()
            .find_map(|line| line.trim().strip_prefix("problem:"))
            .or_else(|| log[at].trim().strip_prefix("error:")),
        None => log
            .iter()
            .rev()
            .map(String::as_str)
            .find(|line| !line.trim().is_empty()),
    }
    .map(str::trim)
    .filter(|line| !line.is_empty())
    .unwrap_or("ic sandbox connect stopped without saying why");
    let line = line.trim_end_matches(['.', ':']);
    format!("{line}.")
}

/// This machine's host name, for the names its page answers to.
fn hostname() -> String {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// The addresses a device on the network reaches this machine by: each IPv4 address `ip` names on an interface of the
/// machine's own (never loopback, link-local, or a container bridge), else the one its default route leaves from.
fn addresses() -> Vec<String> {
    let listed = docker::run_bounded("ip", &["-4", "-o", "addr", "show"], Duration::from_secs(5))
        .ok()
        .filter(|ran| ran.code == Some(0))
        .map(|ran| lan_addresses(&ran.stdout))
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed;
    }
    // Connecting a UDP socket sends nothing; it only picks the address the route out would leave from.
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| socket.connect("1.1.1.1:80").map(|()| socket))
        .and_then(|socket| socket.local_addr())
        .ok()
        .map(|address| address.ip())
        .filter(|ip| !ip.is_loopback() && !ip.is_unspecified())
        .map(|ip| vec![ip.to_string()])
        .unwrap_or_default()
}

/// The addresses in `ip -4 -o addr show`, without loopback, link-local, and the bridges containers and VMs sit
/// behind, which no other device reaches. Pure.
pub fn lan_addresses(listing: &str) -> Vec<String> {
    const BRIDGES: &[&str] = &["docker", "br-", "veth", "virbr", "cni", "podman", "lxc"];
    let mut found = Vec::new();
    for line in listing.lines() {
        let words: Vec<&str> = line.split_whitespace().collect();
        let (Some(interface), Some(&"inet"), Some(cidr)) =
            (words.get(1), words.get(2), words.get(3))
        else {
            continue;
        };
        let address = cidr.split('/').next().unwrap_or_default();
        let Ok(ip) = address.parse::<std::net::Ipv4Addr>() else {
            continue;
        };
        if ip.is_loopback()
            || ip.is_link_local()
            || *interface == "lo"
            || BRIDGES.iter().any(|bridge| interface.starts_with(bridge))
        {
            continue;
        }
        if !found.contains(&ip.to_string()) {
            found.push(ip.to_string());
        }
    }
    found
}

/// The page's addresses as a person types them: its name on the network first, then each address. Pure.
pub fn page_urls(addresses: &[String], port: u16) -> Vec<String> {
    let suffix = if port == 80 {
        String::new()
    } else {
        format!(":{port}")
    };
    std::iter::once("intentic.local".to_string())
        .chain(addresses.iter().cloned())
        .map(|host| format!("http://{host}{suffix}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_code_wins_and_a_failed_one_frees_the_attempt() {
        let shared: Shared = Arc::new(Mutex::new(State::waiting()));
        let (codes, arrived) = mpsc::channel();
        assert_eq!(
            claim(&shared, "FirstCode1", &codes, "the console"),
            Claim::Accepted
        );
        assert_eq!(
            claim(&shared, "SecondCode", &codes, "this page"),
            Claim::Busy
        );
        assert_eq!(arrived.try_recv().as_deref(), Ok("FirstCode1"));
        assert!(arrived.try_recv().is_err());
        assert!(lock(&shared).message.contains("the console"));
        lock(&shared).phase = Phase::Failed;
        assert_eq!(
            claim(&shared, "SecondCode", &codes, "this page"),
            Claim::Accepted
        );
        assert_eq!(arrived.try_recv().as_deref(), Ok("SecondCode"));
        lock(&shared).phase = Phase::Done;
        assert_eq!(
            claim(&shared, "ThirdCode1", &codes, "this page"),
            Claim::Done
        );
        assert!(arrived.try_recv().is_err());
    }

    #[test]
    fn the_console_hands_in_codes_and_skips_what_is_none() {
        let shared: Shared = Arc::new(Mutex::new(State::waiting()));
        let (codes, arrived) = mpsc::channel();
        let typed =
            "\nhello\ncurl -fsSL https://intentic.dev/setup/vphf3wkQ7xK | sh\nOtherCode123\n";
        console(typed.as_bytes(), &shared, &codes);
        // The second code found the first still being tried.
        assert_eq!(
            arrived.try_iter().collect::<Vec<_>>(),
            vec!["vphf3wkQ7xK".to_string()]
        );
    }

    #[test]
    fn a_failed_connect_is_told_by_the_line_it_stopped_on() {
        let log = |lines: &[&str]| {
            lines
                .iter()
                .map(|line| line.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            stopped_on(&log(&[
                "intentic: claiming the setup code…",
                "error: that setup code has expired",
                "more"
            ])),
            "that setup code has expired."
        );
        assert_eq!(
            stopped_on(&log(&["intentic: pulling", "docker said no.", ""])),
            "docker said no."
        );
        // What `ic sandbox connect` prints when its preflight fails (seen in a run against an unreachable platform).
        assert_eq!(
            stopped_on(&log(&[
                "  FAIL  Platform reachable",
                "error: found 1 problem — fix them and re-run the same command:",
                "",
                "  1. Platform reachable",
                "     problem: could not reach the platform at http://127.0.0.1:9 — io: Connection refused (os error 111)",
                "     fix:     check this device's internet connection (DNS, proxy, firewall), then re-run.",
            ])),
            "could not reach the platform at http://127.0.0.1:9 — io: Connection refused (os error 111)."
        );
        assert_eq!(
            stopped_on(&[]),
            "ic sandbox connect stopped without saying why."
        );
    }

    #[test]
    fn the_page_is_offered_on_the_machines_own_addresses_only() {
        let listing = "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever\n\
2: enp1s0    inet 192.168.1.20/24 brd 192.168.1.255 scope global dynamic noprefixroute enp1s0\\       valid_lft 3423sec preferred_lft 3423sec\n\
3: wlp2s0    inet 10.0.0.7/24 brd 10.0.0.255 scope global wlp2s0\\       valid_lft forever preferred_lft forever\n\
4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever\n\
5: br-3f2a1c    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-3f2a1c\\       valid_lft forever preferred_lft forever\n\
6: enp1s0    inet 169.254.10.2/16 scope link enp1s0\n\
7: tailscale0    inet 100.101.102.103/32 scope global tailscale0\n";
        assert_eq!(
            lan_addresses(listing),
            vec!["192.168.1.20", "10.0.0.7", "100.101.102.103"]
        );
        assert!(lan_addresses("").is_empty());
        assert!(lan_addresses("garbage line\n2: eth0 inet6 fe80::1/64").is_empty());
    }

    #[test]
    fn the_port_is_spelled_only_when_it_is_not_80() {
        let addresses = vec!["192.168.1.20".to_string()];
        assert_eq!(
            page_urls(&addresses, 80),
            vec!["http://intentic.local", "http://192.168.1.20"]
        );
        assert_eq!(
            page_urls(&addresses, 8080),
            vec!["http://intentic.local:8080", "http://192.168.1.20:8080"]
        );
    }
}
