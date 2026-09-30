import type { HostReport, HostedStatus } from "@intentic/api-contract";
import type { EdgeVerdict, SandboxVitals } from "@intentic/sandbox-contract";
import type { ConnectionFailure } from "../live/connection";

// WHY A SANDBOX ISN'T ANSWERING, as a pure function of what could be observed while it wasn't. The connection machine
// (connection.ts) knows only that a stream failed and how; this file adds what a few bounded probes found out after
// (probes.ts) and what the machine the sandbox runs on reported to the platform (`hostReport`), and names the one cause
// they establish. Its first job is the distinction every surface used to get wrong: a sandbox that is BUSY (its front
// says the daemon is up, or anything behind the edge answered) is never described as down, and never offered a way back.

// What the probe of the sandbox's own address found (probes.ts `probeFront`).
export type FrontProbe =
    // The front answered its vitals route: the container is up, and this is how its daemon is.
    | { readonly kind: "vitals"; readonly vitals: SandboxVitals }
    // Something behind the edge answered, just not with vitals: an older sandbox's daemon, or a front refusing on its
    // behalf. Either way the container is up.
    | { readonly kind: "answered" }
    // The edge answered for it, and holds no working tunnel.
    | { readonly kind: "edge"; readonly verdict: EdgeVerdict }
    // The front said its daemon is restarting (503, no edge verdict).
    | { readonly kind: "restarting" }
    // Nothing answered within the probe's budget: a tunnel the edge still holds (a computer that slept a moment ago is
    // held for up to 45 s), or a daemon too stalled to answer.
    | { readonly kind: "silent" }
    // This browser could not reach the address at all: its network, or something on it blocking ours.
    | { readonly kind: "unreachable" };

export type HostedMachineState = HostedStatus[`machine`];

export interface Evidence {
    // When the probe that produced this settled.
    readonly at: number;
    // What the browser says of its own network (`navigator.onLine`); only its `false` is trustworthy.
    readonly online: boolean;
    // Whether the platform answered the last refresh of the sandbox list.
    readonly platform: "ok" | "down" | undefined;
    readonly front: FrontProbe | undefined;
    // Own machine, probed only where no permission prompt would be raised: the sandbox answered on this computer's own
    // loopback address.
    readonly loopback: boolean | undefined;
    // Hosted only: the machine's power state, as the platform asked its provider.
    readonly hosted: HostedMachineState | undefined;
}

export type Lane = "hosted" | "own";

export interface DiagnosisInput {
    // Network-shaped failures only: a refusal, a removal and a missing address each have their own screen.
    readonly failure: ConnectionFailure | undefined;
    // The visible part of the current outage (useRecovery.ts `useVisibleOutage`).
    readonly outageMs: number;
    // When the current outage began, to tell a report written about it from one written before it.
    readonly outageStartedAt: number | undefined;
    readonly lane: Lane;
    // Hosted only: whether the machine came warm from the pool (seconds to wake) or is built to order (minutes).
    readonly warm: boolean | undefined;
    readonly evidence: Evidence | undefined;
    readonly hostReport: HostReport | null | undefined;
    readonly now: number;
}

// How the machine a sandbox runs on is doing, from its own report.
export type MachineStanding = "working" | "needs-you" | "fixed";

export type Diagnosis =
    // Nothing observed yet beyond a failed stream.
    | { readonly kind: "checking" }
    // This device has no network.
    | { readonly kind: "offline" }
    // The platform does not answer this device either.
    | { readonly kind: "platform-down" }
    // The platform answers and the sandbox's address does not reach anything from here: a network in between.
    | { readonly kind: "unreachable" }
    // Alive and slow. `since` is how long the outage has lasted.
    | { readonly kind: "busy"; readonly vitals: SandboxVitals | undefined; readonly longMs: number }
    | { readonly kind: "restarting"; readonly restarts: number }
    | { readonly kind: "crashing"; readonly restarts: number }
    // Hosted: its machine is on its way up, and it has not outlasted the patience its situation earns.
    | { readonly kind: "waking"; readonly machine: HostedMachineState | undefined }
    // Hosted: its machine failed, is gone, or is on and never connected.
    | { readonly kind: "hosted-down"; readonly machine: HostedMachineState | undefined }
    // Own machine: that machine's own recent account of it.
    | { readonly kind: "machine"; readonly report: HostReport; readonly standing: MachineStanding }
    // Own machine: not dialled in, and nothing heard from the machine about it. `patient` while it may yet redial.
    | { readonly kind: "not-dialled"; readonly patient: boolean; readonly lastReport: HostReport | undefined }
    // Own machine: it answers on this very computer and not through Intentic, so this computer's way out is the fault.
    | { readonly kind: "local-only" }
    // The address answers nothing and says nothing. `patient` while that may still be a slept computer being let go.
    | { readonly kind: "silent"; readonly patient: boolean };

/* PATIENCE, per cause. Each is how long a wait is still a wait: past it, the reader is handed what they can do. */

// A computer that restarted, or woke, redials within seconds; a machine agent that noticed the silence (it looks after
// 60 s) has reported by well before this, and a report outranks this patience whenever it lands.
export const OWN_REDIAL_PATIENCE_MS = 100_000;
// A hosted machine from the warm pool wakes in about twenty seconds; one built to order pulls its image first.
export const HOSTED_WARM_PATIENCE_MS = 90_000;
export const HOSTED_COLD_PATIENCE_MS = 5 * 60_000;
// The edge lets go of a tunnel whose far side went quiet after 45 s (tunnel `DEAD_AFTER`), so silence this long is no
// longer a slept computer being let go.
export const SILENT_PATIENCE_MS = 60_000;
// A daemon the front restarted this many times in its ten-minute window is not coming back by restarting.
export const CRASH_LOOP_RESTARTS = 3;
// A restart that has not come back in this long is not a restart any more.
export const RESTARTING_PATIENCE_MS = 2 * 60_000;
// A report older than the outage by more than this describes another one; the agent may write a moment before this
// browser notices, so a little before counts.
const REPORT_LEAD_MS = 30_000;
// A machine still "checking" or "fixing" this long after it last wrote has stopped writing.
const REPORT_STALE_MS = 10 * 60_000;
// "Fixed" is the machine's word; the sandbox itself has this long to prove it by dialling in.
const FIXED_PATIENCE_MS = 3 * 60_000;

const reportTime = (report: HostReport): number => Date.parse(report.at);

// The machine's report, if it is about THIS outage and still current.
export const freshReport = (report: HostReport | null | undefined, outageStartedAt: number | undefined, now: number): HostReport | undefined => {
    if (report === null || report === undefined || outageStartedAt === undefined) {
        return undefined;
    }
    const at = reportTime(report);
    if (Number.isNaN(at) || at < outageStartedAt - REPORT_LEAD_MS) {
        return undefined;
    }
    return report.stage !== `done` && now - at > REPORT_STALE_MS ? undefined : report;
};

export const machineStanding = (report: HostReport): MachineStanding => {
    if (report.stage === `asking`) {
        return `needs-you`;
    }
    if (report.stage !== `done`) {
        return `working`;
    }
    return report.outcome === `healthy` || report.outcome === `fixed` ? `fixed` : `needs-you`;
};

const vitalsDiagnosis = (vitals: SandboxVitals, input: DiagnosisInput): Diagnosis => {
    if (vitals.node === `up`) {
        return { kind: `busy`, vitals, longMs: input.outageMs };
    }
    if (vitals.restarts >= CRASH_LOOP_RESTARTS || input.outageMs >= RESTARTING_PATIENCE_MS) {
        return { kind: `crashing`, restarts: vitals.restarts };
    }
    return { kind: `restarting`, restarts: vitals.restarts };
};

const HOSTED_DOWN: ReadonlySet<HostedMachineState> = new Set([`failed`, `gone`, `destroyed`, `destroying`]);

// Not dialled in, on a machine the platform runs: its power state says whether this is still a boot.
const hostedDetached = (input: DiagnosisInput): Diagnosis => {
    const machine = input.evidence?.hosted;
    if (machine !== undefined && HOSTED_DOWN.has(machine)) {
        return { kind: `hosted-down`, machine };
    }
    const patience = input.warm === false ? HOSTED_COLD_PATIENCE_MS : HOSTED_WARM_PATIENCE_MS;
    return input.outageMs < patience ? { kind: `waking`, machine } : { kind: `hosted-down`, machine };
};

// Not dialled in, on somebody's own machine: its own report first, then this computer's loopback, then patience.
const ownDetached = (input: DiagnosisInput): Diagnosis => {
    const report = freshReport(input.hostReport, input.outageStartedAt, input.now);
    if (report !== undefined) {
        const standing = machineStanding(report);
        const provedWrong = standing === `fixed` && input.now - reportTime(report) > FIXED_PATIENCE_MS;
        if (!provedWrong) {
            return { kind: `machine`, report, standing };
        }
    }
    if (input.evidence?.loopback === true) {
        return { kind: `local-only` };
    }
    const lastReport = input.hostReport ?? undefined;
    return { kind: `not-dialled`, patient: input.outageMs < OWN_REDIAL_PATIENCE_MS, lastReport };
};

const detached = (input: DiagnosisInput): Diagnosis => (input.lane === `hosted` ? hostedDetached(input) : ownDetached(input));

// Nothing answered: a hosted machine's power state can still say more; an own machine's report can too.
const silent = (input: DiagnosisInput): Diagnosis => {
    if (input.lane === `hosted` && input.evidence?.hosted !== undefined && input.evidence.hosted !== `started`) {
        return hostedDetached(input);
    }
    if (input.lane === `own` && freshReport(input.hostReport, input.outageStartedAt, input.now) !== undefined) {
        return ownDetached(input);
    }
    return { kind: `silent`, patient: input.outageMs < SILENT_PATIENCE_MS };
};

const unreachable = (input: DiagnosisInput): Diagnosis => (input.evidence?.platform === `down` ? { kind: `platform-down` } : { kind: `unreachable` });

const fromFront = (front: FrontProbe, input: DiagnosisInput): Diagnosis => {
    switch (front.kind) {
        case `vitals`:
            return vitalsDiagnosis(front.vitals, input);
        case `answered`:
            return { kind: `busy`, vitals: undefined, longMs: input.outageMs };
        case `restarting`:
            return input.outageMs >= RESTARTING_PATIENCE_MS ? { kind: `crashing`, restarts: 0 } : { kind: `restarting`, restarts: 0 };
        case `edge`:
            return detached(input);
        case `silent`:
            return silent(input);
        case `unreachable`:
            return unreachable(input);
    }
};

export const diagnose = (input: DiagnosisInput): Diagnosis => {
    const { evidence } = input;
    if (evidence?.online === false) {
        return { kind: `offline` };
    }
    if (evidence?.front !== undefined) {
        return fromFront(evidence.front, input);
    }
    // No probe has settled yet: the connection's own reading is all there is.
    return input.failure?.kind === `detached` ? detached(input) : { kind: `checking` };
};

// Whether the sandbox has shown a sign of life: the busy reading, and the one every "is it down" question defers to.
export const isAlive = (diagnosis: Diagnosis): boolean => diagnosis.kind === `busy`;
