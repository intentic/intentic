import type { Config } from "../../env.config.js";

// Every way a `local` daemon run (an editor extension, a CLI, over a folder the user owns) differs from the container,
// named as traits rather than left implicit. Subsystems read the trait, not the profile value, so a future posture
// composes from the same booleans instead of new branches.
export interface ProfileTraits {
    // Whether this daemon may converge the machine's HOME onto its own roots; true only in the container.
    readonly convergeHome: boolean;
    // Whether workspace repos' git dirs are moved out of the tree (--separate-git-dir); container-only.
    readonly relocateGitDirs: boolean;
    // Whether the tmux server is this daemon's own to sweep and manage; false when it may be the user's.
    readonly sharedTmux: boolean;
    // Whether the container's extra listeners (TLS loopback, preview proxy) run; false for a single local port.
    readonly extraListeners: boolean;
    // Whether container-image update checks (version check, release notes) run; a local daemon is not an image.
    readonly containerUpdates: boolean;
    // Whether container-only capabilities (dockerd, VPN auto-connect, env overlay) converge at boot.
    readonly containerCapabilities: boolean;
    // Whether the daemon converges the workspace's agent-facing config at boot; false if that folder is the user's.
    readonly ownsWorkspaceConfig: boolean;
    // Whether the workspace's resident automation (scheduler, approvals, CI hooks) runs; off locally for now.
    readonly residentAutomation: boolean;
    // Whether the extension system's runtime (autostart, backend host, update watch) runs; off locally for now.
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

// Addresses treated as loopback; an untouched 0.0.0.0 default is rewritten to loopback, not refused, for a local run.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

// What a local daemon listens on: the configured host, except that a container-shaped 0.0.0.0 default collapses to
// loopback.
export const listenHost = (config: Config): string => {
    if (config.sandbox.profile !== "local") {
        return config.sandbox.host;
    }
    return config.sandbox.host === "0.0.0.0" ? "127.0.0.1" : config.sandbox.host;
};

// Fail-closed floor for the local profile, which authenticates nobody: refuses to serve rather than silently open every
// route to the LAN when env implies a reachable or platform-connected daemon.
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
        `FATAL: SANDBOX_PROFILE=local serves this machine only, with no authentication, but this env says otherwise:\n${complaints
            .map((line) => `  - ${line}\n`)
            .join("")}Unset these (or drop SANDBOX_PROFILE=local) and restart.\n`,
    );
    process.exit(78); // EX_CONFIG, same as the auth floor.
};
