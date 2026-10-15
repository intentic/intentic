#!/usr/bin/env bash
# A docker config that leaves out the credential helpers it names but this shell cannot run. Sourced by the scripts
# that build images from a checkout; call `docker_config_without_missing_helpers` before the first docker call:
#
#   . "$(dirname "$0")/../lib/docker-config.sh"
#   docker_config_without_missing_helpers
#
# WHY IT EXISTS. Docker Desktop writes `"credsStore": "desktop.exe"` into the docker config of every WSL distro it
# serves and never takes it back, while the helper itself lives on the Windows side. It is found only through the
# Windows PATH, which a shell started without it does not have: a device agent's, one with appendWindowsPath off, or
# any shell once Docker Desktop is gone. Docker asks that helper before every pull, the `# syntax=` frontend included,
# so the build dies before it reaches a registry: `error getting credentials - err: exec:
# "docker-credential-desktop.exe": executable file not found in $PATH`. Seen on rog, 2026-10-15: the Sandbox page's
# rebuild stopped 5s in, inside build-netd.sh.
#
# A local build pulls only public images, and those need no credentials, so it builds the same image without the
# helper. The user's own config is never edited. Docker reads a copy instead (DOCKER_CONFIG), and every other entry in
# that copy links back to the original: cli-plugins (where our buildx is linked), contexts, buildx's builders. A
# helper that is on PATH is kept, and so are credentials stored inline under `auths`. The function changes nothing when
# no helper is missing, when there is no config, or when node is not installed.

docker_config_without_missing_helpers() {
    _docker_config_from="${DOCKER_CONFIG:-$HOME/.docker}"
    _docker_config_copy="${XDG_CACHE_HOME:-$HOME/.cache}/intentic/docker-config"
    [ -f "$_docker_config_from/config.json" ] || return 0
    command -v node >/dev/null 2>&1 || return 0
    # Already the copy (a script calling another that calls this too): it holds no missing helper by construction.
    [ "$(cd "$_docker_config_from" && pwd -P)" = "$(cd "$_docker_config_copy" 2>/dev/null && pwd -P)" ] && return 0
    # Prints the helpers it left out, and nothing when the config needed no copy.
    _docker_config_dropped="$(node - "$_docker_config_from" "$_docker_config_copy" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [from, copy] = process.argv.slice(2).map((dir) => path.resolve(dir));
let config;
try {
    config = JSON.parse(fs.readFileSync(path.join(from, "config.json"), "utf8"));
} catch {
    process.exit(0); // docker's own error about its config says more than this one would
}
const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
const runnable = (helper) =>
    dirs.some((dir) => {
        try {
            fs.accessSync(path.join(dir, `docker-credential-${helper}`), fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
const dropped = new Set();
if (typeof config.credsStore === "string" && config.credsStore !== "" && !runnable(config.credsStore)) {
    dropped.add(config.credsStore);
    delete config.credsStore;
}
const helpers = typeof config.credHelpers === "object" && config.credHelpers !== null ? config.credHelpers : {};
for (const [registry, helper] of Object.entries(helpers)) {
    if (typeof helper === "string" && !runnable(helper)) {
        dropped.add(helper);
        delete helpers[registry];
    }
}
if (dropped.size === 0) process.exit(0);
// Brought up to date in place rather than rebuilt, so two builds starting together never see it half made: each link
// and the config are swapped in by rename. A real directory docker made here itself (buildx, when the original has
// none) is left alone.
fs.mkdirSync(copy, { recursive: true });
const swapIn = (name, write) => {
    const tmp = path.join(copy, `.${name}.${process.pid}`);
    fs.rmSync(tmp, { force: true });
    write(tmp);
    fs.renameSync(tmp, path.join(copy, name));
};
const kept = new Set(fs.readdirSync(from).filter((name) => name !== "config.json"));
for (const name of fs.readdirSync(copy)) {
    if (name !== "config.json" && !kept.has(name) && fs.lstatSync(path.join(copy, name)).isSymbolicLink()) fs.rmSync(path.join(copy, name));
}
for (const name of kept) {
    const target = path.join(from, name);
    let current;
    try {
        current = fs.lstatSync(path.join(copy, name));
    } catch {}
    if (current && !current.isSymbolicLink()) continue;
    if (current && fs.readlinkSync(path.join(copy, name)) === target) continue;
    swapIn(name, (tmp) => fs.symlinkSync(target, tmp));
}
swapIn("config.json", (tmp) => fs.writeFileSync(tmp, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 }));
console.log([...dropped].map((helper) => `docker-credential-${helper}`).join(", "));
JS
)" || return 0
    [ -n "$_docker_config_dropped" ] || return 0
    DOCKER_CONFIG="$_docker_config_copy"
    export DOCKER_CONFIG
    echo "docker's config names a credential helper not on PATH here ($_docker_config_dropped), so this build reads a copy without it ($DOCKER_CONFIG). It pulls only public images, which need no credentials." >&2
}
