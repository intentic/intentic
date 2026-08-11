import { computed, ref } from "vue";
import { isLocalPosture } from "../../environments/posture";
import { type Endpoint, selectEndpoint } from "./endpoint";
import { setStreamCapacity, streamCapacity } from "./streamBudget";
import { useSandbox } from "./useSandbox";

/* THE TRANSPORT half of "where is the sandbox", as a module-level singleton — the counterpart to
 * `useSandbox().daemonUrl`, which stays the sandbox's public IDENTITY.
 *
 * That split is the whole point. `daemonUrl` was doing two jobs: it is what every daemon call is appended to,
 * AND it is what the switcher reads a slug off, the infra panel derives a Cloudflare zone from, desktop sync
 * names a folder after, and the editor-bridge snippet pastes into a config that runs on some machine we
 * cannot identify. Swapping it to a loopback address to make calls faster would silently corrupt all five.
 * So calls move to `daemonBase` and identity stays put; the two differ only when the shortcut is in use.
 *
 * Resolution is deliberately NOT on the critical path. The tunnel is known-good and serves from the first
 * paint; the local probe runs in the background and, when it qualifies, the base changes under callers that
 * read it per request (which is all of them — see sandboxRpc's url()/headers() hooks). The stream is the one
 * caller holding a base for a long time, so useSandboxLiveness watches for the change and reconnects. */

// The resolved endpoint per sandbox id. In memory only: a stale choice must not outlive the session that
// observed it (the laptop that moves from the desk to a train is the case), and a reload's re-probe costs one
// loopback request — Chrome remembers its Local Network Access grant per origin, so it is not a fresh prompt.
const endpoints = ref<Record<string, Endpoint>>({});
// Sandboxes whose local shortcut was tried and demoted this session. A demotion means "this stopped working
// while we were on it" — re-probing on the next tick would flap between two addresses, so it stands until the
// user switches away and back, or reloads.
const demoted = new Set<string>();
// One in-flight resolve per sandbox, so a switch that wakes several consumers still probes once.
const resolving = new Map<string, Promise<void>>();

const { active, activeSandboxId, daemonUrl } = useSandbox();

/* The base every daemon call is appended to: the resolved endpoint when there is one, else the public URL.
 * Falling back to the tunnel rather than to `undefined` is what keeps resolution off the critical path — a
 * call made before the probe lands is not delayed or dropped, just not accelerated. */
const daemonBase = computed<string | undefined>(() => {
    const id = activeSandboxId.value;
    const resolved = id === undefined ? undefined : endpoints.value[id];
    return resolved?.base ?? daemonUrl.value;
});

// Is the active sandbox being reached over the loopback shortcut? Read by the connection driver (to know that
// a failure is worth demoting rather than backing off) and by the connection detail the shell renders.
const usingLocal = computed(() => {
    const id = activeSandboxId.value;
    const kind = id === undefined ? undefined : endpoints.value[id]?.kind;
    // Either loopback form — what makes a failure worth demoting is that a known-good address remains, and
    // that is equally true whichever of the two we happened to qualify.
    return kind === `local` || kind === `local-insecure`;
});

/* How many long-lived streams this tab may hold at once, which only the TRANSPORT can answer — h2 multiplexes
 * them onto one connection, plain http/1.1 spends a whole connection each and a browser has six per origin.
 * Read live (not snapshotted) because the endpoint resolves in the background and can change under a stream
 * that is already open, which is this module's whole design. See streamBudget.ts for what happens without it. */
setStreamCapacity(() => {
    const id = activeSandboxId.value;
    return streamCapacity(id === undefined ? undefined : endpoints.value[id]?.kind);
});

/* Qualify the active sandbox's fastest working address. Safe to call on every reconnect: it returns
 * immediately once the sandbox has a resolved endpoint, and coalesces concurrent callers. */
const resolve = async (): Promise<void> => {
    // The local posture's engine URL already IS loopback — there is no faster address to qualify, and the
    // probe would derive candidates from a connect token the local engine doesn't have.
    if (isLocalPosture()) {
        return;
    }
    const id = activeSandboxId.value;
    const url = daemonUrl.value;
    if (id === undefined || url === undefined || url === `` || endpoints.value[id] !== undefined || demoted.has(id)) {
        return;
    }
    const pending = resolving.get(id);
    if (pending !== undefined) {
        return pending;
    }
    const attempt = (async (): Promise<void> => {
        const endpoint = await selectEndpoint({ daemonUrl: url, token: active.value?.token });
        // The sandbox may have been switched (or demoted) during the probe; writing the result under the id
        // we probed FOR — never under whatever is active now — is what keeps it off the wrong sandbox.
        if (!demoted.has(id)) {
            endpoints.value = { ...endpoints.value, [id]: endpoint };
        }
    })().finally(() => resolving.delete(id));
    resolving.set(id, attempt);
    return attempt;
};

/* Give up on the shortcut for this session and fall back to the tunnel. Called when a call fails while the
 * local endpoint is in use — docker restarted, the machine slept, the user is now on a different network than
 * the container. The tunnel is known-good, so this is a repair, not an outage. */
const demote = (sandboxId: string): void => {
    demoted.add(sandboxId);
    const rest = { ...endpoints.value };
    delete rest[sandboxId];
    endpoints.value = rest;
};

// Re-open the question of the shortcut for a sandbox: a switch away and back is the user's own "try again"
// for one demoted earlier in the session, and the machine they are on may have changed since. Only the
// demotion is cleared — an endpoint already resolved and working is left exactly as it is, so a switch costs
// no probe and no reconnect in the ordinary case.
const reset = (sandboxId: string): void => {
    demoted.delete(sandboxId);
};

export function useEndpoint() {
    return { daemonBase, usingLocal, resolve, demote, reset };
}
