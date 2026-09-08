import { computed, ref } from "vue";
import { couldBeOnThisMachine, type Endpoint, probeEndpoint, sandboxIdOf, selectEndpoint, settledEndpoint } from "./endpoint";
import { shortcutAnswer, useLocalShortcut } from "../devices/localShortcut";
import { setStreamCapacity, setStreamOverflow, setStreamScope, streamPermits } from "../client/streamBudget";
import { useSandbox } from "../client/useSandbox";

// Transport half of `useSandbox`: calls resolve through `daemonBase` here, while `daemonUrl` remains the sandbox's
// identity used elsewhere. Resolution stays off the critical path: the tunnel serves first paint, and a background
// probe swaps callers' base once a local address qualifies.

// Resolved endpoint per sandbox id, kept in memory only; a reload re-probes cheaply (LNA grant persists).
const endpoints = ref<Record<string, Endpoint>>({});
// A demotion expires on a backoff that doubles per consecutive failure and caps at `DEMOTION_MAX_MS`; expiry
// permits the next reconnect's probe, it does not trigger one itself.
const DEMOTION_BASE_MS = 60_000;
const DEMOTION_MAX_MS = 30 * 60_000;

interface Demotion {
    readonly at: number;
    // Consecutive demotions the backoff is based on; cleared only by `reset`, never by an expiry.
    readonly streak: number;
}

const demoted = new Map<string, Demotion>();

const demotionHolds = (sandboxId: string, now: number): boolean => {
    const entry = demoted.get(sandboxId);
    if (entry === undefined) {
        return false;
    }
    const cooldown = Math.min(DEMOTION_BASE_MS * 2 ** (entry.streak - 1), DEMOTION_MAX_MS);
    return now - entry.at < cooldown;
};
// One in-flight resolve per sandbox: concurrent callers await it instead of starting their own.
const resolving = new Map<string, Promise<void>>();

const { active, activeSandboxId, daemonUrl } = useSandbox();
const { ask } = useLocalShortcut();

// Base every daemon call is appended to: the resolved endpoint if present, else the public URL. Falling back
// rather than blocking is what keeps resolution off the critical path.
const daemonBase = computed<string | undefined>(() => {
    const id = activeSandboxId.value;
    const resolved = id === undefined ? undefined : endpoints.value[id];
    return resolved?.base ?? daemonUrl.value;
});

// Whether the active sandbox is reached over the loopback shortcut; read by the connection driver (to gate
// demotion) and the shell's connection detail.
const usingLocal = computed(() => {
    const id = activeSandboxId.value;
    const kind = id === undefined ? undefined : endpoints.value[id]?.kind;
    // Either loopback variant counts: what matters for demotion is that a known-good address remains.
    return kind === `local` || kind === `local-insecure`;
});

// True when only the plain, non-multiplexing address is reachable: the browser's six-connections-per-origin
// ceiling then silently starves agents, so this is surfaced to the user rather than left as a diagnostic.
const degradedTransport = computed(() => {
    const id = activeSandboxId.value;
    return id !== undefined && endpoints.value[id]?.kind === `local-insecure`;
});

// Stream capacity depends on the transport (h2 multiplexes; http/1.1 spends one of six per-origin connections
// each), read live since the endpoint can change mid-stream. All three stream hooks live here because this module alone
// knows the transport.
setStreamCapacity((stream) => {
    const id = activeSandboxId.value;
    return streamPermits(id === undefined ? undefined : endpoints.value[id]?.kind, stream);
});
setStreamScope(() => daemonBase.value ?? `unaddressed`);
// On overflow, re-probes immediately instead of demoting: reaching this state means every multiplexed address
// already failed, so demoting would spend a backoff on an address just proven dead.
setStreamOverflow(() => {
    const id = activeSandboxId.value;
    if (id !== undefined) {
        resolvedAt.delete(id);
    }
});

// When each sandbox's endpoint resolved; `settledEndpoint` (endpoint.ts) ages a provisional one out with it.
const resolvedAt = new Map<string, number>();

// Qualifies the active sandbox's fastest address; safe to call on every reconnect or frame since it short-circuits
// once settled and coalesces concurrent callers.
const resolve = async (): Promise<void> => {
    const id = activeSandboxId.value;
    const url = daemonUrl.value;
    const sandbox = active.value;
    const now = Date.now();
    if (
        id === undefined ||
        sandbox === undefined ||
        url === undefined ||
        url === `` ||
        settledEndpoint(endpoints.value[id], resolvedAt.get(id), now) ||
        demotionHolds(id, now)
    ) {
        return;
    }
    // Avoids asking about a shortcut that cannot exist for this browser; also checked inside `candidatesFor`.
    if (!couldBeOnThisMachine(sandbox)) {
        return;
    }
    // Returns without probing until loopback permission is allowed (localShortcut.ts, loopbackPermission.ts).
    const answer = await shortcutAnswer(id);
    if (answer !== `allowed`) {
        if (answer === `unasked`) {
            ask(id);
        }
        return;
    }
    const pending = resolving.get(id);
    if (pending !== undefined) {
        return pending;
    }
    const attempt = (async (): Promise<void> => {
        const endpoint = await selectEndpoint({
            daemonUrl: url,
            // Null on a member's row: no id to derive a loopback candidate from, so the tunnel it is (endpoint.ts).
            token: sandbox.token ?? undefined,
            hosted: sandbox.hosted,
            // Forwarded, never recomputed: the platform owns the certificate zone (endpoint.ts Addressing).
            localHostname: sandbox.localHostname,
        });
        // Written under the id probed for, not whatever is active now, in case the sandbox switched mid-probe.
        if (!demotionHolds(id, Date.now())) {
            // Stamped even when the answer is unchanged, so a still-missing certificate still buys another interval.
            resolvedAt.set(id, Date.now());
            endpoints.value = { ...endpoints.value, [id]: endpoint };
        }
    })().finally(() => resolving.delete(id));
    resolving.set(id, attempt);
    return attempt;
};

// Falls back to the tunnel after a local-endpoint failure (docker restart, sleep, network change). Treated as a
// temporary repair: the backoff above re-admits the shortcut once it heals.
const demote = (sandboxId: string): void => {
    demoted.set(sandboxId, { at: Date.now(), streak: (demoted.get(sandboxId)?.streak ?? 0) + 1 });
    const rest = { ...endpoints.value };
    delete rest[sandboxId];
    resolvedAt.delete(sandboxId);
    endpoints.value = rest;
};

// Probes before demoting: a broken stream does not always mean a broken address, and demoting on every failure
// flaps the window between two paths to the same busy daemon. Returns whether it demoted, since the caller's retry
// differs either way.
const demoteIfUnreachable = async (sandboxId: string): Promise<boolean> => {
    const endpoint = endpoints.value[sandboxId];
    const sandbox = active.value;
    const token = sandbox?.token ?? undefined;
    if (endpoint === undefined || token === undefined || token === ``) {
        // No endpoint or token to check against: demotes unconditionally rather than guessing.
        demote(sandboxId);
        return true;
    }
    if (await probeEndpoint(endpoint, await sandboxIdOf(token))) {
        return false;
    }
    demote(sandboxId);
    return true;
};

// Clears only the demotion, not any already-resolved endpoint, so switching sandboxes costs no probe or reconnect
// unless one was pending.
const reset = (sandboxId: string): void => {
    demoted.delete(sandboxId);
};

export function useEndpoint() {
    return { daemonBase, usingLocal, degradedTransport, resolve, demote, demoteIfUnreachable, reset };
}
