import { computed, ref } from "vue";
import { couldBeOnThisMachine, type Endpoint, selectEndpoint } from "./endpoint";
import { shortcutAnswer, useLocalShortcut } from "./localShortcut";
import { setStreamCapacity, streamCapacity } from "./streamBudget";
import { useSandbox } from "./useSandbox";

/* THE TRANSPORT half of "where is the sandbox", as a module-level singleton, the counterpart to
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
 * read it per request (which is all of them, see sandboxRpc's url()/headers() hooks). The stream is the one
 * caller holding a base for a long time, so useSandboxLiveness watches for the change and reconnects. */

// The resolved endpoint per sandbox id. In memory only: a stale choice must not outlive the session that
// observed it (the laptop that moves from the desk to a train is the case), and a reload's re-probe costs one
// loopback request. Chrome remembers its Local Network Access grant per origin, so it is not a fresh prompt.
const endpoints = ref<Record<string, Endpoint>>({});
/* Sandboxes whose local shortcut was tried and demoted, and WHEN, because a demotion has to expire.
 *
 * A demotion means "this stopped working while we were on it", and re-probing on the next tick would flap
 * between two addresses, so it has to stand for a while. It used to stand for the whole session, which made
 * every cause permanent regardless of how temporary it was: the machine sleeping, docker restarting, wifi
 * dropping for a moment. All of those heal on their own within seconds, and the tab stayed on the tunnel until
 * someone thought to reload it, paying a round trip to a Cloudflare edge and back for a daemon one hop away.
 *
 * So it expires instead, on a backoff. A shortcut that keeps failing backs off toward the cap and stops
 * costing anything to retry. What makes the retry cheap is that `selectEndpoint` PROBES before it adopts
 * (endpoint.ts, identity-checked against /health), so a local address that is still broken is rejected without
 * a connection being moved onto it: the expiry risks one probe, not one outage.
 *
 * Expiry is PERMISSION to probe again, not a probe: `resolve` runs on each connect attempt
 * (useSandboxLiveness), so the shortcut returns at the next reconnect after the cooldown rather than on a
 * timer of its own. That is the case worth healing anyway. The failures that demote are network-shaped, and a
 * network that has changed is reconnecting regardless, which is exactly when this is asked again. A tunnel
 * stream that never breaks keeps the sandbox on the tunnel, and deliberately retargeting a healthy connection
 * to chase a shortcut is the flapping this backoff exists to prevent. */
const DEMOTION_BASE_MS = 60_000;
const DEMOTION_MAX_MS = 30 * 60_000;

interface Demotion {
    readonly at: number;
    // Consecutive demotions, which is what the backoff is a function of. Cleared by `reset`, the user's own
    // "try again", never by an expiry: expiring is what earns the NEXT attempt, not a clean slate.
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
// One in-flight resolve per sandbox, so a switch that wakes several consumers still probes once.
const resolving = new Map<string, Promise<void>>();

const { active, activeSandboxId, daemonUrl } = useSandbox();
const { ask } = useLocalShortcut();

/* The base every daemon call is appended to: the resolved endpoint when there is one, else the public URL.
 * Falling back to the tunnel rather than to `undefined` is what keeps resolution off the critical path, a
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
    // Either loopback form, what makes a failure worth demoting is that a known-good address remains, and
    // that is equally true whichever of the two we happened to qualify.
    return kind === `local` || kind === `local-insecure`;
});

/* How many long-lived streams this tab may hold at once, which only the TRANSPORT can answer, h2 multiplexes
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
    const id = activeSandboxId.value;
    const url = daemonUrl.value;
    const sandbox = active.value;
    if (id === undefined || sandbox === undefined || url === undefined || url === `` || endpoints.value[id] !== undefined || demotionHolds(id, Date.now())) {
        return;
    }
    /* Nothing to qualify: the platform put this sandbox's machine somewhere this browser demonstrably is not
     * (endpoint.ts), so the probe could only spend a Local Network Access prompt on an address that will never
     * answer. Checked HERE as well as inside `candidatesFor`, that call would correctly return the tunnel
     * alone, but only after this module had already decided to ask the user about a shortcut that does not
     * exist for them. */
    if (!couldBeOnThisMachine(sandbox)) {
        return;
    }
    /* The probe is the app's only reach for the machine this browser runs on, and the browser interrupts with a
     * permission dialog the first time it happens. So the app asks first, in its own words, and this returns
     * without probing until the answer is yes, the notice calls back in (localShortcut.ts). */
    const answer = shortcutAnswer(id);
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
        const endpoint = await selectEndpoint({ daemonUrl: url, token: sandbox.token, cloud: sandbox.cloud, hosted: sandbox.hosted });
        // The sandbox may have been switched (or demoted) during the probe; writing the result under the id
        // we probed FOR, never under whatever is active now, is what keeps it off the wrong sandbox.
        if (!demotionHolds(id, Date.now())) {
            endpoints.value = { ...endpoints.value, [id]: endpoint };
        }
    })().finally(() => resolving.delete(id));
    resolving.set(id, attempt);
    return attempt;
};

/* Fall back to the tunnel for now. Called when a call fails while the local endpoint is in use, docker
 * restarted, the machine slept, the user is now on a different network than the container. The tunnel is
 * known-good, so this is a repair, not an outage, and it lasts only as long as the backoff above: every one
 * of those causes is temporary, so the shortcut is owed another probe once it has had time to right itself. */
const demote = (sandboxId: string): void => {
    demoted.set(sandboxId, { at: Date.now(), streak: (demoted.get(sandboxId)?.streak ?? 0) + 1 });
    const rest = { ...endpoints.value };
    delete rest[sandboxId];
    endpoints.value = rest;
};

// Re-open the question of the shortcut for a sandbox: a switch away and back is the user's own "try again"
// for one demoted earlier in the session, and the machine they are on may have changed since. Only the
// demotion is cleared, an endpoint already resolved and working is left exactly as it is, so a switch costs
// no probe and no reconnect in the ordinary case.
const reset = (sandboxId: string): void => {
    demoted.delete(sandboxId);
};

export function useEndpoint() {
    return { daemonBase, usingLocal, resolve, demote, reset };
}
