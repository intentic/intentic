import { useEndpoint } from "./useEndpoint";
import { useSandbox } from "./useSandbox";

// One immutable destination for one authenticated operation. Both the address and its credentials are read in
// the same tick, so switching sandboxes while Google/session work is awaiting cannot pair one daemon's token
// with another daemon's URL or connect secret.
export interface SandboxTarget {
    readonly sandboxId: string | undefined;
    readonly base: string;
    readonly connectToken: string | undefined;
}

export const currentSandboxTarget = (): SandboxTarget | undefined => {
    const { active, activeSandboxId } = useSandbox();
    const { daemonBase } = useEndpoint();
    const base = daemonBase.value;
    if (base === undefined || base === ``) {
        return undefined;
    }
    return { sandboxId: activeSandboxId.value, base, connectToken: active.value?.token };
};

/* The same destination for a sandbox this browser is NOT pointed at, what the surfaces that read across
 * sandboxes address their calls with (the fleet board's All-sandboxes scope, the changes ledger).
 *
 * Nothing new is trusted to make this work: `sandbox.list()` already hands the browser a `daemonUrl` and a
 * connect token for every sandbox the user can reach, `sandboxSession` already keys its bearers by sandbox
 * id, and `sandboxAuthenticatedFetch` already takes the target explicitly. This is the missing lookup, not a
 * new capability.
 *
 * IT USES THE TUNNEL, ALWAYS, and that is the difference from `currentSandboxTarget`. The loopback shortcut is
 * qualified by a probe that costs up to 1500 ms per candidate and, the first time a browser reaches for the
 * machine it runs on, a Chrome Local Network Access prompt (endpoint.ts). Resolving one is worth that for the
 * sandbox being worked in; resolving five, on a board that opened to show counts, is a permission dialog and
 * a wall of probes spent on machines nobody asked to talk to. The tunnel is known-good and needs no probe.
 *
 * The active sandbox is the exception and delegates, so a call aimed by id at the box already selected keeps
 * every optimization that box has earned (its resolved endpoint, its stream's socket pool). */
export const targetFor = (sandboxId: string): SandboxTarget | undefined => {
    const { sandboxes, activeSandboxId } = useSandbox();
    if (sandboxId === activeSandboxId.value) {
        return currentSandboxTarget();
    }
    const sandbox = sandboxes.value.find((entry) => entry.id === sandboxId);
    const base = sandbox?.daemonUrl;
    if (sandbox === undefined || base === null || base === undefined || base === ``) {
        return undefined;
    }
    return { sandboxId, base, connectToken: sandbox.token };
};
