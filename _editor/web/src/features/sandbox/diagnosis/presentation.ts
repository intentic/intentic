import type { HostCheck, HostReport } from "@intentic/api-contract";
import type { SandboxVitals } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import type { Diagnosis } from "./diagnose";

// WHAT A DIAGNOSIS SAYS, pure: one title, one sentence, whether anything is still expected to happen by itself, and at
// most one thing to press, with anything else behind "other options". The words are the reader's: a cause they can do
// something about, or a wait they can stop worrying about — never a list of commands to choose from.

// How long a sandbox may be busy before the reader is offered a restart, which ends the work it is busy with.
export const BUSY_RESTART_AFTER_MS = 5 * 60_000;
// Pressure above this share of the last ten seconds is worth naming as the reason it is slow.
const PRESSURE_WORTH_NAMING = 40;

// What a press does. `fix` is the command (or the desktop app's button) that runs `ic sandbox fix` on the machine.
export type DiagnosisAction = "restart-hosted" | "rollback-hosted" | "fix";

export type LinkState = "ok" | "down" | "working" | "unknown";

export interface ChainLink {
    readonly id: "device" | "network" | "machine" | "sandbox";
    readonly label: string;
    readonly state: LinkState;
}

export interface DiagnosisNotice {
    readonly title: string;
    readonly body: string;
    // Something is expected to happen by itself: the spinner, and the reason nothing is pressed.
    readonly waiting: boolean;
    readonly tone: "info" | "warning";
    readonly chain: readonly ChainLink[];
    readonly action: DiagnosisAction | undefined;
    readonly otherActions: readonly DiagnosisAction[];
    // The machine's own findings, worth listing: everything it did not find fine.
    readonly findings: readonly HostCheck[];
}

export interface PresentationInput {
    readonly diagnosis: Diagnosis;
    readonly name: string;
    readonly lane: "hosted" | "own";
    readonly owner: boolean;
    readonly canRollBack: boolean;
}

type Links = readonly [device: LinkState, network: LinkState, machine: LinkState, sandbox: LinkState];

const chainOf = (states: Links, machineLabel: string): ChainLink[] => [
    { id: `device`, label: t(`sandbox.diagnosis.linkDevice`), state: states[0] },
    { id: `network`, label: t(`sandbox.diagnosis.linkNetwork`), state: states[1] },
    { id: `machine`, label: machineLabel, state: states[2] },
    { id: `sandbox`, label: t(`sandbox.diagnosis.linkSandbox`), state: states[3] },
];

const machineName = (input: PresentationInput, report: HostReport | undefined): string =>
    input.lane === `hosted` ? t(`sandbox.diagnosis.ourMachine`) : report?.machine ?? t(`sandbox.diagnosis.itsComputer`);

// Everything the machine did not find fine, the failures first.
export const findingsOf = (report: HostReport): HostCheck[] => {
    const order = { fail: 0, fixing: 1, warn: 2 } as const;
    return report.checks
        .filter((check): check is HostCheck & { state: keyof typeof order } => check.state in order)
        .toSorted((a, b) => order[a.state] - order[b.state]);
};

// Why it is slow, when its netd says: the pressure that is highest, if it is high enough to be the reason.
const busyReason = (vitals: SandboxVitals | undefined): string | undefined => {
    const pressure = vitals?.pressure;
    if (pressure === null || pressure === undefined) {
        return undefined;
    }
    const top = Math.max(pressure.cpu, pressure.memory, pressure.io);
    if (top < PRESSURE_WORTH_NAMING) {
        return undefined;
    }
    if (pressure.cpu === top) {
        return t(`sandbox.diagnosis.busyCpu`);
    }
    return pressure.memory === top ? t(`sandbox.diagnosis.busyMemory`) : t(`sandbox.diagnosis.busyDisk`);
};

const notice = (
    fields: Pick<DiagnosisNotice, `title` | `body` | `waiting`> & Partial<Omit<DiagnosisNotice, `title` | `body` | `waiting` | `chain`>>,
    chain: ChainLink[],
): DiagnosisNotice => ({
    tone: fields.waiting ? `info` : `warning`,
    action: undefined,
    otherActions: [],
    findings: [],
    ...fields,
    chain,
});

// The way back for a machine we run: a restart, and the version before the last change where the platform kept one.
const hostedWayBack = (input: PresentationInput, rollbackFirst: boolean): Pick<DiagnosisNotice, `action` | `otherActions`> => {
    if (rollbackFirst && input.canRollBack) {
        return { action: `rollback-hosted`, otherActions: [`restart-hosted`] };
    }
    return { action: `restart-hosted`, otherActions: input.canRollBack ? [`rollback-hosted`] : [] };
};

const busyNotice = (input: PresentationInput, diagnosis: Extract<Diagnosis, { kind: "busy" }>, machine: string): DiagnosisNotice => {
    const reason = busyReason(diagnosis.vitals);
    const long = diagnosis.longMs >= BUSY_RESTART_AFTER_MS;
    const body = long
        ? t(`sandbox.diagnosis.busyLong`, { minutes: Math.floor(diagnosis.longMs / 60_000) })
        : reason ?? t(`sandbox.diagnosis.busyBody`);
    const offer = long && input.owner ? [input.lane === `hosted` ? (`restart-hosted` as const) : (`fix` as const)] : [];
    return notice(
        { title: t(`sandbox.diagnosis.busyTitle`, { name: input.name }), body, waiting: true, tone: `info`, otherActions: offer },
        chainOf([`ok`, `ok`, `ok`, `working`], machine),
    );
};

const machineNotice = (input: PresentationInput, diagnosis: Extract<Diagnosis, { kind: "machine" }>): DiagnosisNotice => {
    const { report } = diagnosis;
    const machine = machineName(input, report);
    const findings = findingsOf(report);
    if (diagnosis.standing === `working`) {
        return notice(
            {
                title: t(`sandbox.diagnosis.machineWorkingTitle`, { machine, name: input.name }),
                body: report.doing ?? t(`sandbox.diagnosis.machineChecking`),
                waiting: true,
                findings,
            },
            chainOf([`ok`, `ok`, `working`, `unknown`], machine),
        );
    }
    if (diagnosis.standing === `fixed`) {
        return notice(
            { title: t(`sandbox.diagnosis.machineFixedTitle`, { machine }), body: t(`sandbox.diagnosis.machineFixedBody`, { name: input.name }), waiting: true },
            chainOf([`ok`, `ok`, `ok`, `working`], machine),
        );
    }
    const asking = report.stage === `asking`;
    return notice(
        {
            title: asking ? t(`sandbox.diagnosis.machineAskingTitle`, { machine }) : t(`sandbox.diagnosis.machineNeedsYouTitle`, { machine, name: input.name }),
            body: asking ? (report.doing ?? t(`sandbox.diagnosis.machineAskingBody`)) : t(`sandbox.diagnosis.machineNeedsYouBody`),
            waiting: asking,
            findings,
            action: asking || !input.owner ? undefined : `fix`,
        },
        chainOf([`ok`, `ok`, `down`, `unknown`], machine),
    );
};

const notDialledNotice = (input: PresentationInput, diagnosis: Extract<Diagnosis, { kind: "not-dialled" }>): DiagnosisNotice => {
    const machine = machineName(input, diagnosis.lastReport);
    if (diagnosis.patient) {
        return notice(
            { title: t(`sandbox.diagnosis.redialTitle`, { name: input.name }), body: t(`sandbox.diagnosis.redialBody`), waiting: true },
            chainOf([`ok`, `ok`, `unknown`, `unknown`], machine),
        );
    }
    return notice(
        {
            title: t(`sandbox.diagnosis.notConnectedTitle`, { name: input.name }),
            body: diagnosis.lastReport === undefined ? t(`sandbox.diagnosis.notConnectedBody`) : t(`sandbox.diagnosis.notConnectedHeardBefore`, { machine }),
            waiting: false,
            action: input.owner ? `fix` : undefined,
        },
        chainOf([`ok`, `ok`, `down`, `unknown`], machine),
    );
};

// Asleep on its own machine: this visit has asked for it back, which its keeper there does within a minute while that
// computer is on. Past that, the attended fix starts it (`ic sandbox fix` wakes a sleeping sandbox when a person asks).
const asleepNotice = (input: PresentationInput, diagnosis: Extract<Diagnosis, { kind: "asleep" }>): DiagnosisNotice => {
    const machine = machineName(input, diagnosis.report);
    if (diagnosis.patient) {
        return notice(
            { title: t(`sandbox.diagnosis.asleepTitle`, { name: input.name }), body: t(`sandbox.diagnosis.asleepBody`, { machine }), waiting: true },
            chainOf([`ok`, `ok`, `working`, `unknown`], machine),
        );
    }
    return notice(
        {
            title: t(`sandbox.diagnosis.asleepStuckTitle`, { name: input.name }),
            body: t(`sandbox.diagnosis.asleepStuckBody`, { machine }),
            waiting: false,
            action: input.owner ? `fix` : undefined,
        },
        chainOf([`ok`, `ok`, `down`, `unknown`], machine),
    );
};

const silentNotice = (input: PresentationInput, patient: boolean, machine: string): DiagnosisNotice => {
    if (patient) {
        return notice(
            { title: t(`sandbox.diagnosis.silentTitle`, { name: input.name }), body: t(`sandbox.diagnosis.silentBody`), waiting: true },
            chainOf([`ok`, `ok`, `unknown`, `unknown`], machine),
        );
    }
    const wayBack = !input.owner ? {} : input.lane === `hosted` ? hostedWayBack(input, false) : { action: `fix` as const };
    return notice(
        { title: t(`sandbox.diagnosis.stuckTitle`, { name: input.name }), body: t(`sandbox.diagnosis.stuckBody`), waiting: false, ...wayBack },
        chainOf([`ok`, `ok`, `unknown`, `down`], machine),
    );
};

const crashingNotice = (input: PresentationInput, restarts: number, machine: string): DiagnosisNotice => {
    const wayBack = !input.owner ? {} : input.lane === `hosted` ? hostedWayBack(input, true) : { action: `fix` as const };
    return notice(
        {
            title: t(`sandbox.diagnosis.crashingTitle`, { name: input.name }),
            body: restarts > 0 ? t(`sandbox.diagnosis.crashingBody`, { count: restarts }, restarts) : t(`sandbox.diagnosis.crashingBodyUncounted`),
            waiting: false,
            ...wayBack,
        },
        chainOf([`ok`, `ok`, `ok`, `down`], machine),
    );
};

const hostedDownNotice = (input: PresentationInput, diagnosis: Extract<Diagnosis, { kind: "hosted-down" }>, machine: string): DiagnosisNotice => {
    const wayBack = input.owner ? hostedWayBack(input, false) : {};
    return notice(
        {
            title: t(`sandbox.diagnosis.hostedDownTitle`, { name: input.name }),
            body: diagnosis.machine === `failed` ? t(`sandbox.diagnosis.hostedFailedBody`) : t(`sandbox.diagnosis.hostedStuckBody`),
            waiting: false,
            ...wayBack,
        },
        chainOf([`ok`, `ok`, `down`, `unknown`], machine),
    );
};

export const presentDiagnosis = (input: PresentationInput): DiagnosisNotice => {
    const { diagnosis, name } = input;
    const machine = machineName(input, undefined);
    switch (diagnosis.kind) {
        case `checking`:
            return notice({ title: t(`sandbox.diagnosis.checkingTitle`, { name }), body: t(`sandbox.diagnosis.checkingBody`), waiting: true }, []);
        case `offline`:
            return notice(
                { title: t(`sandbox.diagnosis.offlineTitle`), body: t(`sandbox.diagnosis.offlineBody`, { name }), waiting: true },
                chainOf([`down`, `unknown`, `unknown`, `unknown`], machine),
            );
        case `platform-down`:
            return notice(
                { title: t(`sandbox.diagnosis.platformDownTitle`), body: t(`sandbox.diagnosis.platformDownBody`), waiting: true },
                chainOf([`ok`, `down`, `unknown`, `unknown`], machine),
            );
        case `unreachable`:
            return notice(
                { title: t(`sandbox.diagnosis.unreachableTitle`, { name }), body: t(`sandbox.diagnosis.unreachableBody`), waiting: true, tone: `warning` },
                chainOf([`ok`, `down`, `unknown`, `unknown`], machine),
            );
        case `busy`:
            return busyNotice(input, diagnosis, machine);
        case `restarting`:
            return notice(
                { title: t(`sandbox.diagnosis.restartingTitle`, { name }), body: t(`sandbox.diagnosis.restartingBody`), waiting: true },
                chainOf([`ok`, `ok`, `ok`, `working`], machine),
            );
        case `crashing`:
            return crashingNotice(input, diagnosis.restarts, machine);
        case `waking`:
            return notice(
                {
                    title: t(`sandbox.diagnosis.wakingTitle`, { name }),
                    body: diagnosis.machine === `started` ? t(`sandbox.diagnosis.wakingBooting`) : t(`sandbox.diagnosis.wakingBody`),
                    waiting: true,
                },
                chainOf([`ok`, `ok`, `working`, `unknown`], machine),
            );
        case `hosted-down`:
            return hostedDownNotice(input, diagnosis, machine);
        case `machine`:
            return machineNotice(input, diagnosis);
        case `not-dialled`:
            return notDialledNotice(input, diagnosis);
        case `asleep`:
            return asleepNotice(input, diagnosis);
        case `local-only`:
            return notice(
                { title: t(`sandbox.diagnosis.localOnlyTitle`, { name }), body: t(`sandbox.diagnosis.localOnlyBody`), waiting: false },
                chainOf([`ok`, `down`, `ok`, `ok`], t(`sandbox.diagnosis.thisComputer`)),
            );
        case `silent`:
            return silentNotice(input, diagnosis.patient, machine);
    }
};
