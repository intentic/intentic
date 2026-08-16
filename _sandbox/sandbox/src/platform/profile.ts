import type { Config } from "../env.config.js";

/* THE PROFILE SEAM — every way "local" differs from the container, in one place.
 *
 * The daemon has always been able to run bare (`tsx watch`, the integration tests): config is env-driven,
 * auth is legitimately absent on an unreachable daemon, and the heavyweight subsystems already gate on the
 * binaries and env the container bakes. What was missing is the posture being NAMED — a bare run behaved
 * safely by accident of which env happened to be unset. `sandbox.profile = "local"` makes it a contract:
 * a host application (an editor extension, a CLI) starts the daemon over a folder the user owns, and the
 * traits below are the promises that make that safe.
 *
 * Subsystems read the TRAIT, never the profile value: each boolean names the one behavior it gates and says
 * why local differs, so a future posture composes from the same vocabulary instead of growing else-branches.
 */
export interface ProfileTraits {
    /* May this daemon claim the machine's HOME and converge ~/.claude, ~/.ssh and the connector hooks onto
     * its own roots? True only in the container, where HOME is ephemeral and exists to be converged. On a
     * user's machine those are THEIR stores — the exact hijack container-owner.ts exists to prevent, made a
     * standing rule rather than a race the claim file happens to win. */
    readonly convergeHome: boolean;
    /* Move workspace repos' git dirs out of the tree (the --separate-git-dir shape)? That shape serves
     * namespace isolation and agent-tamper-proofing — container concerns. Locally the repos are the user's
     * own, `git worktree` needs no relocation, and reshaping a repo somebody also uses outside this daemon
     * is exactly the surprise the local posture promises never to spring. */
    readonly relocateGitDirs: boolean;
    /* Is the tmux server this daemon's own? In the container yes — sweep stale sessions at boot, wrap agent
     * shell commands into visible panes, reap finished ones. On a user's machine the tmux server (if any) is
     * theirs, shared with their own sessions and any second local daemon — never sweep it, never assume it. */
    readonly sharedTmux: boolean;
    /* The container's extra listeners: the TLS loopback listener (a tunnel-avoiding shortcut — meaningless
     * when the ONLY listener is already loopback) and the preview proxy the tunnel's preview hostnames land
     * on. Local serves one plain loopback port and nothing else. */
    readonly extraListeners: boolean;
    /* Container-image update offers: the version check and release-notes fetch behind the Update card. A
     * local daemon is not an image; its host application owns its update story. */
    readonly containerUpdates: boolean;
    /* Container capabilities converged at boot: dockerd, auto-connect VPN tunnels, the environment overlay
     * recompose, preview-route minting. All act on container furniture that does not exist locally. */
    readonly containerCapabilities: boolean;
    /* Does the daemon own the workspace's agent-facing config, converging it at boot — the baked-tool skill
     * files and the drafts skill? In the container yes: the folder exists for the daemon and arrives empty.
     * Locally no: the folder is the user's, and writing (or deleting) files in it that nobody asked for is the
     * litter the local posture promises not to leave. Config a user changes through the daemon's own routes is
     * still written — that write was asked for. */
    readonly ownsWorkspaceConfig: boolean;
    /* The workspace's resident automation: the automations scheduler, the drafts publisher, CI hooks and the
     * poller, maintenance probes. Off locally for now — the local surfaces (chat, agents, accounts) show
     * none of it. */
    readonly residentAutomation: boolean;
    /* The extension system's runtime: autoStart processes, the backend host, the update watch. Off locally
     * for now — no local surface lists or installs extensions. */
    readonly extensionHost: boolean;
}

const CONTAINER: ProfileTraits = {
    convergeHome: true,
    relocateGitDirs: true,
    sharedTmux: true,
    extraListeners: true,
    containerUpdates: true,
    containerCapabilities: true,
    ownsWorkspaceConfig: true,
    residentAutomation: true,
    extensionHost: true,
};

const LOCAL: ProfileTraits = {
    convergeHome: false,
    relocateGitDirs: false,
    sharedTmux: false,
    extraListeners: false,
    containerUpdates: false,
    containerCapabilities: false,
    ownsWorkspaceConfig: false,
    residentAutomation: false,
    extensionHost: false,
};

export const profileTraits = (config: Config): ProfileTraits => (config.sandbox.profile === "local" ? LOCAL : CONTAINER);

// The addresses a local daemon may bind. "0.0.0.0" is the schema default the container needs; a local run
// that left it untouched means loopback, not "expose my machine" — so it is rewritten, not refused.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/* What a local daemon LISTENS ON: the configured host, except that the container-shaped default collapses to
 * loopback. Explicit loopback spellings pass through; anything else is refused by the floor below. */
export const listenHost = (config: Config): string => {
    if (config.sandbox.profile !== "local") {
        return config.sandbox.host;
    }
    return config.sandbox.host === "0.0.0.0" ? "127.0.0.1" : config.sandbox.host;
};

/* THE LOCAL FLOOR — the fail-closed twin of main.ts requireAuthWhenReachable, for the posture with NO auth
 * at all. A local daemon authenticates nobody (empty GOOGLE_CLIENT_ID is its normal state), which is safe
 * for exactly one shape: a process only this machine can reach, belonging to no platform. Env that
 * contradicts that shape — a bind address the LAN can reach, a connect token, a public URL, a platform to
 * announce to — is not a configuration to soldier through: refuse to serve rather than serve everything.
 * Dying costs a restart with the reason in the log; the silent alternative is every route open to the LAN. */
export const localContractComplaints = (config: Config): string[] => {
    if (config.sandbox.profile !== "local") {
        return [];
    }
    const complaints: string[] = [];
    if (!LOOPBACK_HOSTS.has(listenHost(config))) {
        complaints.push(`SANDBOX_HOST=${config.sandbox.host} is not a loopback address`);
    }
    if (config.connectToken !== "") {
        complaints.push("CONNECT_TOKEN is set (a local daemon is nobody's sandbox)");
    }
    if (config.sandbox.publicUrl !== "") {
        complaints.push("SANDBOX_PUBLIC_URL is set (a local daemon has no tunnel)");
    }
    if (config.platform.url !== "") {
        complaints.push("PLATFORM_URL is set (a local daemon announces to no platform)");
    }
    return complaints;
};

export const requireLocalContract = (config: Config): void => {
    const complaints = localContractComplaints(config);
    if (complaints.length === 0) {
        return;
    }
    process.stderr.write(
        `FATAL: SANDBOX_PROFILE=local serves this machine only, with no authentication — but this env says otherwise:\n` +
            complaints.map((line) => `  - ${line}\n`).join("") +
            `Unset these (or drop SANDBOX_PROFILE=local) and restart.\n`,
    );
    process.exit(78); // EX_CONFIG, same as the auth floor
};
