use crate::docker;

/* EVERYTHING ic CREATES SAYS WHO MADE IT AND FOR WHAT (the audit's rule 1, 2026-10). A container, a volume, a network
or a build that ic makes carries Docker labels naming its sandbox, what kind of thing it is, the side of this computer
whose ic made it (the platform and the environment: `windows`, or `linux/<distro>` inside WSL) and the ic version that
made it. Objects made before these labels keep working by name, as every verb still finds them: the labels are for new
objects, and for the selections a later cleanup makes (`docker volume ls --filter label=…`) instead of guessing from a
name prefix that a person's own objects could share. */

pub const SANDBOX: &str = "dev.intentic.sandbox";
pub const KIND: &str = "dev.intentic.kind";
pub const SIDE: &str = "dev.intentic.side";
pub const IC: &str = "dev.intentic.ic";

/// What an object is, as its `dev.intentic.kind` label says it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Sandbox,
    Runner,
    /// The Windows deploy target beside a sandbox (connect.rs, Windows only).
    #[cfg_attr(not(windows), allow(dead_code))]
    Dind,
    BackupWorker,
    VolumeWorkspace,
    VolumeHistory,
    VolumeDocker,
    #[cfg_attr(not(windows), allow(dead_code))]
    VolumeDindDocker,
    Network,
    Environment,
    TrashMarker,
}

impl Kind {
    pub fn wire(self) -> &'static str {
        match self {
            Kind::Sandbox => "sandbox",
            Kind::Runner => "runner",
            Kind::Dind => "dind",
            Kind::BackupWorker => "backup-worker",
            Kind::VolumeWorkspace => "volume-workspace",
            Kind::VolumeHistory => "volume-history",
            Kind::VolumeDocker => "volume-docker",
            Kind::VolumeDindDocker => "volume-dind-docker",
            Kind::Network => "network",
            Kind::Environment => "environment",
            Kind::TrashMarker => "trash-marker",
        }
    }
}

/// The labels, as `key=value` pairs, for an object of `kind` belonging to `slug`, made by the side `side` (its wire
/// form, side.rs). Pure.
pub fn pairs(slug: &str, kind: Kind, side: &str) -> Vec<String> {
    vec![
        format!("{SANDBOX}={slug}"),
        format!("{KIND}={}", kind.wire()),
        format!("{SIDE}={side}"),
        format!("{IC}={}", crate::VERSION),
    ]
}

/// The same as `--label` arguments. Pure.
pub fn args(slug: &str, kind: Kind, side: &str) -> Vec<String> {
    pairs(slug, kind, side)
        .into_iter()
        .flat_map(|pair| ["--label".to_string(), pair])
        .collect()
}

/// This side's labels for an object of `kind`.
pub fn here(slug: &str, kind: Kind) -> Vec<String> {
    args(slug, kind, &super::side::here().wire())
}

/// A run line the run contract printed (`["run", "-d", …, image]`), with `extra` docker options put right after `run`,
/// where docker reads them as options of this run whatever the contract put after them. Labels ride here, and so does
/// the environment stamp the contract would drop (connect.rs says why). Pure.
pub fn into_run(argv: &[String], extra: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(argv.len() + extra.len());
    match argv.split_first() {
        Some((first, rest)) if first == "run" => {
            out.push(first.clone());
            out.extend(extra.iter().cloned());
            out.extend(rest.iter().cloned());
        }
        // Not a run line: left exactly as it is, since anything put into it would be guessing at its grammar.
        _ => out.extend(argv.iter().cloned()),
    }
    out
}

/// Create the named volume with this side's labels, unless it exists. True when it was made by THIS call: the one
/// fact a failed first setup needs to clean up after itself without touching data an earlier run left.
pub fn create_volume(name: &str, slug: &str, kind: Kind) -> bool {
    if docker::ok(&["volume", "inspect", name]) {
        return false;
    }
    let mut args: Vec<String> = vec!["volume".to_string(), "create".to_string()];
    args.extend(here(slug, kind));
    args.push(name.to_string());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    docker::ok(&refs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_object_names_its_sandbox_kind_side_and_maker() {
        let pairs = pairs("sandbox-abc", Kind::VolumeWorkspace, "linux/archlinux");
        assert_eq!(pairs[0], "dev.intentic.sandbox=sandbox-abc");
        assert_eq!(pairs[1], "dev.intentic.kind=volume-workspace");
        assert_eq!(pairs[2], "dev.intentic.side=linux/archlinux");
        assert!(pairs[3].starts_with("dev.intentic.ic="));
        let args = args("x", Kind::Sandbox, "windows");
        assert_eq!(args.len(), 8);
        assert!(args.iter().step_by(2).all(|flag| flag == "--label"));
    }

    #[test]
    fn options_go_right_after_run_and_anything_else_is_left_alone() {
        let argv: Vec<String> = ["run", "-d", "--name", "x", "img"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let extra = vec!["--label".to_string(), "k=v".to_string()];
        assert_eq!(
            into_run(&argv, &extra),
            vec!["run", "--label", "k=v", "-d", "--name", "x", "img"]
        );
        let other: Vec<String> = vec!["create".to_string(), "img".to_string()];
        assert_eq!(into_run(&other, &extra), other);
        assert!(into_run(&[], &extra).is_empty());
    }
}
