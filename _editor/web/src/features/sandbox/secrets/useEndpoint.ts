import { computed, ref } from "vue";
import { couldBeOnThisMachine, type Endpoint, probeEndpoint, shortcutFailedAlone, sandboxIdOf, selectEndpoint, settledEndpoint } from "./endpoint";
import { shortcutAnswer, useLocalShortcut } from "../devices/loopback/localShortcut";
import { measuredProtocol, setStreamCapacity, setStreamOverflow, setStreamScope, streamPermits } from "../client/streamBudget";
import { useSandbox } from "../client/useSandbox";

// Transport half of `useSandbox`: calls resolve through `daemonBase` here, while `daemonUrl` remains the sandbox's
// identity used elsewhere. Resolution stays off the critical path: the tunnel serves first paint, and a background
// probe swaps callers' base once a local address qualifies.

// Resolved endpoint per sandbox id, kept in memory only; a reload re-probes cheaply (LNA grant persists).
// allow(module-state): the resolved endpoint per sandbox id, one entry per sandbox
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

// Stream capacity depends on the protocol the browser negotiated with the address in use (streamBudget.ts), read live
// since the endpoint can change mid-stream. All three stream hooks live here because this module alone knows the
// transport.
const activeKind = (): Endpoint[`kind`] => {
    const id = activeSandboxId.value;
    return (id === undefined ? undefined : endpoints.value[id]?.kind) ?? `public`;
};
setStreamCapacity((stream) => streamPermits(activeKind(), measuredProtocol(daemonBase.value), stream));
setStreamScope(() => daemonBase.value ?? `unaddressed`);
// A pool fills on the certified loopback name only where the browser is not known to multiplex there (WebKitGTK speaks
// HTTP/1.1 to it): new streams move to the tunnel, which does. Plain HTTP loopback is chosen only when the tunnel failed
// its probe, so it has nowhere to send them: it re-probes for a better address at once, and the stream waits its turn.
setStreamOverflow(() => {
    const id = activeSandboxId.value;
    if (id === undefined) {
        return false;
    }
    const kind = activeKind();
    if (kind === `local`) {
        demote(id);
        return true;
    }
    if (kind === `local-insecure`) {
        resolvedAt.delete(id);
    }
    return false;
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
    // Returns without probing until loopback permission is allowed (loopback/localShortcut.ts, loopback/loopbackPermission.ts).
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

// Who hears that a loopback address stopped answering while the tunnel still does: the authenticated fetch drops the
// calls still waiting on it (sandboxAuthFetch.ts), which would otherwise each sit out the full headers deadline.
const routeLost = new Set<(base: string) => void>();

const onRouteLost = (listener: (base: string) => void): (() => void) => {
    routeLost.add(listener);
    return () => {
        routeLost.delete(listener);
    };
};

// Demotes only when the tunnel answers and the shortcut does not: a broken stream or a missed deadline is as often a
// busy daemon, which is no faster over the tunnel, and demoting then pins the window to the slow path for the whole
// backoff. Returns whether it demoted, since the caller's retry differs either way.
const demoteIfUnreachable = async (sandboxId: string): Promise<boolean> => {
    const endpoint = endpoints.value[sandboxId];
    const token = active.value?.token ?? undefined;
    const tunnel = daemonUrl.value;
    if (endpoint === undefined || token === undefined || token === `` || tunnel === undefined || tunnel === ``) {
        // No endpoint, token or tunnel to check against: demotes unconditionally rather than guessing.
        demote(sandboxId);
        return true;
    }
    if (!(await shortcutFailedAlone(endpoint, tunnel, await sandboxIdOf(token)))) {
        return false;
    }
    demote(sandboxId);
    for (const listener of routeLost) {
        listener(endpoint.base);
    }
    return true;
};

// The loopback address's re-check after the page slept, per sandbox. A machine waking from sleep can leave it dead for
// minutes (a port forward re-binding) while the tunnel answers at once; calls aimed at it wait for this verdict
// (sandboxAuthFetch.ts) instead of each sitting out the headers deadline before the fallback.
const rechecking = new Map<string, Promise<void>>();

// Asks the loopback address alone first, on its short budget, so a live one (the usual wake) holds nothing up; only a
// silent one goes on to ask the tunnel too, which decides whether to leave it.
const recheckAfterWake = (): void => {
    const id = activeSandboxId.value;
    const endpoint = id === undefined ? undefined : endpoints.value[id];
    const token = active.value?.token ?? undefined;
    if (id === undefined || endpoint === undefined || endpoint.kind === `public` || rechecking.has(id)) {
        return;
    }
    const check = (async (): Promise<void> => {
        if (token !== undefined && token !== `` && (await probeEndpoint(endpoint, await sandboxIdOf(token)))) {
            return;
        }
        await demoteIfUnreachable(id);
    })()
        // allow(silent-catch): a re-check that could not run leaves the address as it was, which a missed deadline still demotes.
        .catch(() => undefined)
        .finally(() => rechecking.delete(id));
    rechecking.set(id, check);
};

// The re-check a call to this sandbox should wait for, if one is running.
const routeRechecked = (sandboxId: string): Promise<void> | undefined => rechecking.get(sandboxId);

// Clears only the demotion, not any already-resolved endpoint, so switching sandboxes costs no probe or reconnect
// unless one was pending.
const reset = (sandboxId: string): void => {
    demoted.delete(sandboxId);
};

export function useEndpoint() {
    return { daemonBase, usingLocal, degradedTransport, resolve, demote, demoteIfUnreachable, reset, recheckAfterWake, routeRechecked, onRouteLost };
}
