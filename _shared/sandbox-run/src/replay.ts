// The env a recreate carries from the container it replaces to the next one, and the role each variable plays. Split from
// index.ts, which re-exports all of it; it imports nothing, so a browser bundle can take it.

// The env var the owner's swap ask rides on (`<n>g`, whole GiB of swap alone, not memory plus swap): replayed like the
// caps, and read back by the sandbox to bound its workload leaf. memory-records.ts SWAP_ENV names the same variable.
export const SANDBOX_SWAP_ENV = "SANDBOX_SWAP";

// What a replayed variable says about the sandbox, which decides what a recreate elsewhere keeps of it: a move to another
// machine keeps all but `machine`, a copy keeps neither `identity` nor `machine`.
// - layout: where things are inside the container (roots, key files, the daemon's listeners)
// - platform: which platform, editor and edge it answers to; the same for every sandbox of one deployment
// - identity: who this sandbox is to the platform and the edge, and to the parent it runs for
// - machine: the computer it runs on, and what that computer paired with it at setup
// - choice: the owner's standing asks of the container
// - purpose: what the sandbox was made for
type ReplayRole = "layout" | "platform" | "identity" | "machine" | "choice" | "purpose";

interface ReplayVar {
    readonly name: string;
    readonly role: ReplayRole;
    // A credential: the daemon seals it out of its own environment at boot, alongside its config schema's own secret
    // leaves, so no process it spawns inherits one (sandbox src/seams/sealed-env.ts); a replayed name the daemon's schema
    // also reads must agree with it, which the daemon's suite checks.
    readonly secret?: true;
}

// Vars a recreate replays, in order; image-identity vars are absent, derived from the emitter's own inputs.
export const REPLAY_VARS = [
    { name: "WORKSPACE_ROOT", role: "layout" },
    { name: "HISTORY_ROOT", role: "layout" },
    { name: "AGENT_AUTH_DIR", role: "layout" },
    // The paths of the mounted at-rest keys, never their contents.
    { name: "INTENTIC_AT_REST_KEY_FILE", role: "layout" },
    { name: "INTENTIC_AT_REST_PREVIOUS_KEY_FILE", role: "layout" },
    { name: "SANDBOX_HOST", role: "layout" },
    { name: "SANDBOX_PORT", role: "layout" },
    { name: "SANDBOX_NAME", role: "identity" },
    { name: "PREVIEW_PORT", role: "layout" },
    { name: "GOOGLE_CLIENT_ID", role: "platform" },
    { name: "CONNECT_TOKEN", role: "identity", secret: true },
    { name: "OWNER_EMAIL", role: "identity" },
    { name: "WEB_ORIGIN", role: "platform" },
    { name: "SANDBOX_PUBLIC_URL", role: "identity" },
    { name: "PLATFORM_URL", role: "platform" },
    // Reachability: the signed grant and the edge it dials; replaying it keeps the same public name.
    { name: "SANDBOX_GRANT", role: "identity", secret: true },
    { name: "INGRESS_URL", role: "platform" },
    // The owner's own Cloudflare account, on the path where they mint their own tunnels.
    { name: "CLOUDFLARE_API_TOKEN", role: "platform", secret: true },
    // A multi-line private key for self-hosted deploys: this machine wired as a deploy target.
    { name: "HOST_SSH_KEY", role: "machine", secret: true },
    { name: "SELF_HOST_USER", role: "machine" },
    { name: "SYNC_PAIR_TOKEN", role: "machine", secret: true },
    // Describes the machine, which a recreate doesn't move off; the daemon can't re-derive it.
    { name: "HOST_PAIR_TOKEN", role: "machine", secret: true },
    { name: "HOST_PLATFORM", role: "machine" },
    { name: "HOST_LABEL", role: "machine" },
    { name: "SELF_HOST_ADDRESS", role: "machine" },
    { name: "SELF_HOST_VIA", role: "machine" },
    // The owner's explicit cgroup cap; replayed so it re-emits, unlike docker update's silent retune.
    { name: "SANDBOX_MEMORY", role: "choice" },
    // The owner's other standing asks, replayed like the memory cap: CPU ceiling and runtime directives.
    { name: "SANDBOX_CPUS", role: "choice" },
    { name: "SANDBOX_RUNTIME", role: "choice" },
    // (2026-11-05) The swap the sandbox's work may page into (SANDBOX_SWAP_ENV), replayed so `--memory-swap` is sized by it
    // and the sandbox holds its workload leaf to it. Images published before this row drop it, so `ic` also stamps it on
    // the run line itself when the contract left it off (its shape.rs `swap_stamp`); never both, and never empty.
    { name: SANDBOX_SWAP_ENV, role: "choice" },
    // A runner's parent sandbox and pairing token, replayed since a recreate can't re-derive either.
    { name: "RUNNER_PARENT_URL", role: "identity" },
    { name: "RUNNER_PAIR_TOKEN", role: "identity", secret: true },
    // The dev checkout this container was launched from; allowlisted so `INTENTIC_SET_ENV` can deliver it and every
    // later dev recreate keeps it. A path on the host, meaningless in here except as an argument sent back out.
    { name: "SANDBOX_DEV_ROOT", role: "machine" },
    // The arriving profile's own sandbox definition. Replayed rather than consumed, because a recreate is how a
    // workspace that never filled gets a second chance at it; the daemon applies it only to one that arrived empty.
    { name: "SANDBOX_DEFINITION_SEED", role: "purpose" },
    // The folder of the owner's computer this sandbox was made for, synced into `/work/<name>` (connect.rs). What the
    // sandbox IS rather than a setting: a recreate that dropped it would seed a starter site beside the owner's project.
    { name: "SANDBOX_PROJECT_DIR", role: "purpose" },
    // (2026-10-21) SANDBOX_PROJECTS_HOST, the desktop app's one sandbox per computer that folders attached to, is no
    // longer replayed: every folder gets a sandbox of its own, and such a sandbox's next recreate is an ordinary one.
] as const satisfies readonly ReplayVar[];

type ReplayName = (typeof REPLAY_VARS)[number]["name"];

// The replayed names, in order.
export const REPLAY_ENV: readonly ReplayName[] = REPLAY_VARS.map(({ name }) => name);

// The replayed names whose value is a credential (ReplayVar's `secret`).
export const REPLAY_SECRET_ENV: ReadonlySet<ReplayName> = new Set(REPLAY_VARS.flatMap((entry) => ("secret" in entry ? [entry.name] : [])));

// `printenv -0` / `env -0` output → name/value pairs. NUL framing is the only safe channel for these values:
// HOST_SSH_KEY is a multi-line private key, so anything line-based re-splits it.
export const parseNulEnv = (dump: string): [string, string][] =>
    dump
        .split("\0")
        .filter((entry) => entry.includes("="))
        .map((entry) => {
            const eq = entry.indexOf("=");
            return [entry.slice(0, eq), entry.slice(eq + 1)];
        });

// The pairs a recreate actually replays: allowlisted, empties dropped (an empty secret must not shadow the workspace
// .env), in REPLAY_ENV's canonical order.
export const replayableEnv = (pairs: readonly (readonly [string, string])[]): [string, string][] =>
    REPLAY_ENV.flatMap((name): [string, string][] => {
        const value = pairs.find(([key]) => key === name)?.[1];
        return value === undefined || value === "" ? [] : [[name, value]];
    });
