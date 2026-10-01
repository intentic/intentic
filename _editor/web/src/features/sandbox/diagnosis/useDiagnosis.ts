import { useNow } from "@intentic/ui/async";
import { computed, shallowRef, watch, type ComputedRef } from "vue";
import { apiClient } from "../../../lib/useApi";
import { noteVerdict } from "../client/edgeVerdict";
import { useSandbox } from "../client/useSandbox";
import { loopbackPermission } from "../devices/loopback/loopbackPermission";
import type { ConnectionFailure } from "../live/connection";
import { candidatesFor, couldBeOnThisMachine, probeEndpoint, sandboxIdOf } from "../secrets/endpoint";
import { type Diagnosis, diagnose, type Evidence, type FrontProbe, type HostedMachineState } from "./diagnose";
import { probeFront } from "./probes";

// THE DIAGNOSIS, gathered while the active sandbox is unreachable and dropped the moment it answers. A module singleton
// started beside the connection loop (useSandboxLiveness.ts): it probes on the first failure of an outage, again after
// each later failure no sooner than PROBE_EVERY_MS apart, and holds only what the current outage produced, so nothing it
// found about one sandbox or one outage can explain another.

// Probing more often than this tells nothing new, and every probe is a request to a sandbox that may be struggling.
const PROBE_EVERY_MS = 12_000;
// While the machine is mid-run (a pasted command, the app, or its agent), the page mirrors it: the platform is asked
// this often, which is the only way its report reaches this page.
const MIRROR_EVERY_MS = 4_000;
// A "busy" reading older than this is not evidence of life any more.
const ALIVE_FRESH_MS = 45_000;

// Network-shaped failures: the only ones a diagnosis is about. A refusal, a removal and a missing address each have
// their own screen.
const DIAGNOSED: ReadonlySet<ConnectionFailure[`kind`]> = new Set([`network`, `timeout`, `closed`, `detached`]);

interface Held {
    readonly sandboxId: string;
    // The outage this was gathered in (`connection.unavailableSince`).
    readonly outage: number;
    readonly evidence: Evidence;
}

// allow(module-state): the one outage being diagnosed, keyed by the sandbox and outage it describes
const held = shallowRef<Held | undefined>(undefined);
// Whether the loop is running, flipped by the liveness driver that owns the session.
let running = false;
let inflight: Promise<void> | undefined;
let lastProbeAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const { active, activeSandboxId, connection, reachable, refresh } = useSandbox();

const platformAnswers = async (): Promise<Evidence[`platform`]> => {
    try {
        await refresh();
        return `ok`;
    } catch (error) {
        console.warn("Could not read platform status", error);
        return `down`;
    }
};

const hostedState = async (sandboxId: string): Promise<HostedMachineState | undefined> => {
    try {
        return (await apiClient.sandbox.hostedStatus({ sandboxId })).machine;
    } catch (error) {
        console.warn("Could not read hosted machine status", error);
        return undefined;
    }
};

// Whether the sandbox answers on this computer's own loopback, asked only where it costs no permission prompt: the
// endpoint resolver asks the same addresses under the same rule.
const answersHere = async (): Promise<boolean | undefined> => {
    const box = active.value;
    if (box === undefined || box.daemonUrl === null || box.token === null || !couldBeOnThisMachine(box)) {
        return undefined;
    }
    const permission = await loopbackPermission();
    if (permission !== `granted` && permission !== `ungated`) {
        return undefined;
    }
    const id = await sandboxIdOf(box.token);
    const local = (await candidatesFor({ daemonUrl: box.daemonUrl, token: box.token, hosted: box.hosted, localHostname: box.localHostname })).filter(
        (endpoint) => endpoint.kind !== `public`,
    );
    const answers = await Promise.all(local.map((endpoint) => probeEndpoint(endpoint, id)));
    return answers.some(Boolean);
};

// A dead tunnel or none at all: only then is this computer's loopback worth asking.
const tunnelDown = (front: FrontProbe): boolean => front.kind === `edge` || front.kind === `unreachable` || front.kind === `silent`;

const gather = async (sandboxId: string, daemonUrl: string): Promise<Evidence> => {
    const box = active.value;
    const owner = box?.role === `owner`;
    const hosted = (box?.hosted ?? null) !== null;
    const [platform, front, machine] = await Promise.all([
        platformAnswers(),
        probeFront(daemonUrl),
        hosted && owner ? hostedState(sandboxId) : Promise.resolve(undefined),
    ]);
    if (front.kind === `edge`) {
        noteVerdict(sandboxId, front.verdict);
    }
    const loopback =
        !hosted && owner && tunnelDown(front)
            ? await answersHere().catch((cause: unknown) => {
                  console.warn("Could not probe the local sandbox", cause);
                  return undefined;
              })
            : undefined;
    return { at: Date.now(), online: globalThis.navigator?.onLine !== false, platform, front, loopback, hosted: machine };
};

// What the current outage is, if there is one worth diagnosing.
const outageNow = (): { sandboxId: string; outage: number; daemonUrl: string } | undefined => {
    const { failure, unavailableSince } = connection.value;
    const sandboxId = activeSandboxId.value;
    const daemonUrl = active.value?.daemonUrl ?? undefined;
    if (!running || reachable.value || failure === undefined || !DIAGNOSED.has(failure.kind) || unavailableSince === undefined) {
        return undefined;
    }
    return sandboxId === undefined || daemonUrl === undefined ? undefined : { sandboxId, outage: unavailableSince, daemonUrl };
};

const probe = async (): Promise<void> => {
    const now = outageNow();
    if (now === undefined || inflight !== undefined) {
        return;
    }
    lastProbeAt = Date.now();
    inflight = gather(now.sandboxId, now.daemonUrl)
        .then((evidence) => {
            // Dropped if the sandbox answered or changed while it ran: it describes a moment that has passed.
            const still = outageNow();
            if (still?.sandboxId === now.sandboxId && still.outage === now.outage) {
                held.value = { sandboxId: now.sandboxId, outage: now.outage, evidence };
            }
        })
        .catch((cause: unknown) => {
            console.warn("Could not collect sandbox diagnosis", cause);
            return undefined;
        })
        .finally(() => {
            inflight = undefined;
            schedule();
        });
    await inflight;
};

// Whether the machine is mid-run, which the page mirrors at the faster cadence.
const mirroring = (): boolean => {
    const report = active.value?.hostReport;
    return report !== null && report !== undefined && report.stage !== `done` && Date.now() - Date.parse(report.at) < 10 * 60_000;
};

const schedule = (): void => {
    if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
    }
    if (outageNow() === undefined) {
        return;
    }
    const every = mirroring() ? MIRROR_EVERY_MS : PROBE_EVERY_MS;
    timer = setTimeout(() => void probe(), Math.max(0, lastProbeAt + every - Date.now()));
};

// Asks at once when an outage starts, and on every later failure no sooner than the cadence allows.
const onConnection = (): void => {
    const now = outageNow();
    if (now === undefined) {
        held.value = undefined;
        schedule();
        return;
    }
    if (held.value !== undefined && (held.value.sandboxId !== now.sandboxId || held.value.outage !== now.outage)) {
        held.value = undefined;
    }
    if (held.value === undefined && inflight === undefined) {
        void probe();
        return;
    }
    schedule();
};

watch([connection, activeSandboxId, reachable], onConnection);
// A command the reader just ran starts reporting: switch to the mirror's cadence without waiting out the slower one.
watch(() => active.value?.hostReport?.at, schedule);

export const startDiagnosis = (): void => {
    running = true;
    onConnection();
};

export const stopDiagnosis = (): void => {
    running = false;
    held.value = undefined;
    schedule();
};

// The evidence gathered about the active sandbox's current outage; undefined outside one.
export const diagnosisEvidence = computed<Evidence | undefined>(() => {
    const current = held.value;
    return current !== undefined && current.sandboxId === activeSandboxId.value && current.outage === connection.value.unavailableSince
        ? current.evidence
        : undefined;
});

// For the connection loop, which has no component scope: whether the last probe of this outage saw the sandbox alive.
export const sandboxSeemsAlive = (now = Date.now()): boolean => {
    const evidence = diagnosisEvidence.value;
    if (evidence === undefined || now - evidence.at > ALIVE_FRESH_MS || evidence.front === undefined) {
        return false;
    }
    return evidence.front.kind === `answered` || (evidence.front.kind === `vitals` && evidence.front.vitals.node === `up`);
};

// Component-scoped (its clocks bind to the caller): the diagnosis of the active sandbox, or undefined while it answers
// or while what is wrong is not a silence. `elapsed` is the visible part of the outage (useRecovery.ts), which the
// caller already holds for its own words.
export const useDiagnosis = (clock: { readonly elapsed: ComputedRef<number> }): ComputedRef<Diagnosis | undefined> => {
    const now = useNow(() => !reachable.value && connection.value.unavailableSince !== undefined);
    return computed(() => {
        const { failure, unavailableSince } = connection.value;
        if (reachable.value || failure === undefined || !DIAGNOSED.has(failure.kind)) {
            return undefined;
        }
        const box = active.value;
        const hosted = box?.hosted ?? null;
        return diagnose({
            failure,
            outageMs: clock.elapsed.value,
            outageStartedAt: unavailableSince,
            lane: hosted === null ? `own` : `hosted`,
            warm: hosted?.warm,
            evidence: diagnosisEvidence.value,
            hostReport: box?.role === `owner` ? box.hostReport : undefined,
            now: now.value,
        });
    });
};
