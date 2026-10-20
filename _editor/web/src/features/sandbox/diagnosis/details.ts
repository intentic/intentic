import type { HostReport } from "@intentic/api-contract";
import { formatElapsed, formatTime } from "@intentic/ui";
import type { ConnectionState } from "../../../client/sandbox/connection";
import type { Diagnosis, Evidence, NetdProbe } from "./diagnose";

// THE RAW FACTS BEHIND AN OUTAGE'S SENTENCE, for the reader who presses "Technical details" (components/progress/ProgressMeter.vue).
// The sentence above them is the diagnosis in the reader's words. These lines are what it was made of: how the
// connection failed and how often it has retried, what each probe found, and the machine's own report, check by check.
// Verbatim and untranslated, like any log, because that is what someone asks for when the sentence was not enough
// (a support thread, a bug report). Pure, so a test reads exactly what a reader would.

export interface OutageDetailsInput {
    readonly connection: ConnectionState;
    readonly evidence: Evidence | undefined;
    // The owner's machine's latest report about this sandbox; nobody else is shown one.
    readonly report: HostReport | null | undefined;
    readonly diagnosis: Diagnosis | undefined;
    readonly now: number;
}

const ago = (at: number, now: number): string => `${formatTime(at)} (${formatElapsed((now - at) / 1000)} ago)`;

const netdLine = (netd: NetdProbe): string => {
    switch (netd.kind) {
        case `vitals`: {
            const { vitals } = netd;
            const pressure = vitals.pressure === null ? `` : `, pressure cpu ${vitals.pressure.cpu}% memory ${vitals.pressure.memory}% io ${vitals.pressure.io}%`;
            const lag = vitals.lagMs === null ? `` : `, event-loop lag ${vitals.lagMs} ms`;
            return `sandbox address: netd answered; daemon ${vitals.node}, ${vitals.restarts} restart(s), up ${formatElapsed(vitals.uptimeS)}${lag}${pressure}`;
        }
        case `answered`:
            return `sandbox address: answered (no vitals)`;
        case `edge`:
            return `sandbox address: Intentic's edge answered, verdict "${netd.verdict}" (no tunnel dialled in)`;
        case `restarting`:
            return `sandbox address: netd says the daemon is restarting`;
        case `silent`:
            return `sandbox address: no answer within the probe's deadline`;
        case `unreachable`:
            return `sandbox address: unreachable from this browser`;
    }
};

const evidenceLines = (evidence: Evidence, now: number): string[] => [
    `probe: ${ago(evidence.at, now)}`,
    `this device: ${evidence.online ? `online` : `offline`}`,
    `platform: ${evidence.platform ?? `not asked`}`,
    ...(evidence.netd === undefined ? [] : [netdLine(evidence.netd)]),
    ...(evidence.loopback === undefined ? [] : [`this computer's loopback: ${evidence.loopback ? `the sandbox answers here` : `no answer`}`]),
    ...(evidence.hosted === undefined ? [] : [`hosted machine: ${evidence.hosted}`]),
];

const CHECK_MARK = { ok: `ok  `, warn: `warn`, fail: `FAIL`, fixing: `fix…`, skip: `skip` } as const;

const reportLines = (report: HostReport, now: number): string[] => {
    const at = Date.parse(report.at);
    const when = Number.isNaN(at) ? report.at : ago(at, now);
    const env = report.env === undefined ? `` : `/${report.env}`;
    const outcome = report.outcome === undefined ? `` : `, ${report.outcome}`;
    return [
        `machine report: ${report.machine} (${report.os}${env}, by ${report.source}) at ${when}`,
        `  stage: ${report.stage}${outcome}${report.asleep === true ? `, sandbox asleep` : ``}`,
        ...(report.doing === undefined ? [] : [`  doing: ${report.doing}`]),
        ...report.checks.flatMap((check) => [
            `  [${CHECK_MARK[check.state]}] ${check.label}`,
            ...(check.problem === undefined ? [] : [`         ${check.problem}`]),
            ...(check.remedy === undefined ? [] : [`         → ${check.remedy}`]),
        ]),
    ];
};

export const outageDetails = (input: OutageDetailsInput): string[] => {
    const { connection, now } = input;
    const lines: string[] = [];
    if (connection.unavailableSince !== undefined) {
        lines.push(`unreachable since: ${ago(connection.unavailableSince, now)}`);
    }
    const failure = connection.failure;
    if (failure !== undefined) {
        lines.push(`last failure: ${[failure.kind, failure.message].filter(Boolean).join(`: `)}`);
    }
    const retry = connection.retryDelayMs > 0 ? `, next try within ${formatElapsed(connection.retryDelayMs / 1000)}` : ``;
    lines.push(`connection: ${connection.phase}, attempt ${connection.attempt}${retry}`);
    if (input.evidence !== undefined) {
        lines.push(...evidenceLines(input.evidence, now));
    }
    if (input.report !== null && input.report !== undefined) {
        lines.push(...reportLines(input.report, now));
    }
    const diagnosis = input.diagnosis;
    if (diagnosis !== undefined) {
        const waiting = `patient` in diagnosis ? (diagnosis.patient ? ` (waiting)` : ` (gave up waiting)`) : ``;
        lines.push(`diagnosis: ${diagnosis.kind}${diagnosis.kind === `machine` ? ` (${diagnosis.standing})` : waiting}`);
    }
    return lines;
};
