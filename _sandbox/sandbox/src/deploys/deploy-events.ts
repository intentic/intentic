import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { DEPLOYS_PROVIDER, type DeployEventType, type DeployRecord, type StackHealthState } from "@intentic/sandbox-contract/schemas/deploys";
import { opt } from "../opt.js";

// A DEPLOY'S END AS A `deploys` LISTENER MESSAGE (automations/catalog.ts DEPLOYS_SOURCE), so the owner's automations
// route it as they route CI's: a notice, a Discord message, a fix turn. Sent once per record, when the engine is done
// with it: a failure that is rolled back says `deploy_rolled_back`, never `deploy_failed` first. `channelId` is
// `<repo>:<stack>`, which an automation's channel filter narrows on; `extra` carries the record's facts, never a value.

// The sender every message names: the sandbox's own deploy engine, which vouches for nothing a person typed.
const AUTHOR = { id: "deploys", name: "Deploys" };

// The first line of a failure, enough to recognise it in a notice.
const headOf = (error: string | undefined): string => (error === undefined ? "" : `: ${error.split("\n")[0]?.slice(0, 300) ?? ""}`);

const contentOf = (record: DeployRecord): string => {
    const what = `${record.repo} ${record.stack} @ ${record.commit.slice(0, 8)} on ${record.device}`;
    switch (record.outcome) {
        case "succeeded":
            return `Deployed ${what}${record.trigger.kind === "rollback" ? " (a rollback)" : ""}`;
        case "rolled-back":
            return `Deploy of ${what} failed and was rolled back${headOf(record.error)}`;
        case "refused":
            return `Deploy of ${what} was refused${headOf(record.error)}`;
        default:
            return `Deploy of ${what} failed${headOf(record.error)}`;
    }
};

// The event a record's end is, or undefined for an outcome nobody is told of: a superseded deploy never ran, and a live
// one has not ended.
const deployEventOf = (record: Pick<DeployRecord, "outcome">): DeployEventType | undefined => {
    switch (record.outcome) {
        case "succeeded":
            return "deploy_succeeded";
        case "failed":
            return "deploy_failed";
        case "rolled-back":
            return "deploy_rolled_back";
        case "refused":
            return "deploy_refused";
        default:
            return undefined;
    }
};

// The message for a record that has ended, or undefined for one no automation hears about.
export const deployMessageOf = (record: DeployRecord, at: Date = new Date()): ListenerMessage | undefined => {
    const type = deployEventOf(record);
    if (type === undefined) {
        return undefined;
    }
    return {
        provider: DEPLOYS_PROVIDER,
        type,
        id: `${record.id}:${type}`,
        channelId: `${record.repo}:${record.stack}`,
        ...opt("branch", record.ref),
        author: AUTHOR,
        content: contentOf(record),
        timestamp: at.toISOString(),
        extra: {
            id: record.id,
            repo: record.repo,
            stack: record.stack,
            commit: record.commit,
            device: record.device,
            outcome: record.outcome,
            trigger: record.trigger.kind,
            ...opt("rolledBackTo", record.rolledBackTo),
            ...opt("error", record.error),
        },
    };
};

// ---- what the watch saw (deploy-watch.ts): the same provider, so one automation hears deploys and their aftermath ----

// What a stack on its computer is doing, as the monitor read it: unhealthy (held for two reads) or recovered.
export interface StackStateEvent {
    readonly type: Extract<DeployEventType, "stack_unhealthy" | "stack_recovered">;
    readonly repo: string;
    readonly stack: string;
    readonly device: string;
    readonly state: StackHealthState;
    // When it started reading so.
    readonly since: string;
}

const stateWords = (state: StackHealthState): string => {
    switch (state) {
        case "unhealthy":
            return "is unhealthy (a healthcheck failing, or a container stopped beside the others)";
        case "restarting":
            return "keeps restarting";
        case "stopped":
            return "is stopped";
        case "missing":
            return "is gone from its computer";
        default:
            return `reads ${state}`;
    }
};

export const stackStateMessageOf = (event: StackStateEvent, at: Date = new Date()): ListenerMessage => ({
    provider: DEPLOYS_PROVIDER,
    type: event.type,
    id: `${event.repo}:${event.stack}:${event.type}:${event.since}`,
    channelId: `${event.repo}:${event.stack}`,
    author: AUTHOR,
    content:
        event.type === "stack_recovered"
            ? `${event.repo} ${event.stack} on ${event.device} is running again`
            : `${event.repo} ${event.stack} on ${event.device} ${stateWords(event.state)} since ${event.since}`,
    timestamp: at.toISOString(),
    extra: { repo: event.repo, stack: event.stack, device: event.device, state: event.state, since: event.since },
});

// Secrets a stack received that changed in the store since its last deploy, for a stack whose manifest says `notify`.
export const secretsChangedMessageOf = (
    fields: { readonly repo: string; readonly stack: string; readonly device: string; readonly names: readonly string[]; readonly mark: string },
    at: Date = new Date(),
): ListenerMessage => ({
    provider: DEPLOYS_PROVIDER,
    type: "secrets_changed",
    // The mark is of what changed, never a value: the same change is one event however often it is read.
    id: `${fields.repo}:${fields.stack}:secrets_changed:${fields.mark}`,
    channelId: `${fields.repo}:${fields.stack}`,
    author: AUTHOR,
    content: `${fields.names.join(", ")} changed in the secret store since ${fields.repo} ${fields.stack} on ${fields.device} was last deployed: it still runs with the old value until it is deployed again`,
    timestamp: at.toISOString(),
    extra: { repo: fields.repo, stack: fields.stack, device: fields.device, secrets: [...fields.names] },
});

// A server running low, once per episode: `what` is `memory` or the disk's path.
export interface HostLowEvent {
    readonly type: Extract<DeployEventType, "host_low_disk" | "host_low_memory">;
    readonly device: string;
    readonly what: string;
    readonly freeBytes: number;
    readonly totalBytes: number;
}

const GIB = 1024 ** 3;
const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

export const hostLowMessageOf = (event: HostLowEvent, at: Date = new Date()): ListenerMessage => {
    const percent = event.totalBytes > 0 ? Math.round((event.freeBytes / event.totalBytes) * 100) : 0;
    const what = event.type === "host_low_memory" ? "memory" : `disk ${event.what}`;
    return {
        provider: DEPLOYS_PROVIDER,
        type: event.type,
        id: `device:${event.device}:${event.type}:${event.what}:${at.toISOString()}`,
        channelId: `device:${event.device}`,
        author: AUTHOR,
        content: `${event.device} is low on ${what}: ${gib(event.freeBytes)} free of ${gib(event.totalBytes)} (${percent}%)`,
        timestamp: at.toISOString(),
        extra: { device: event.device, what: event.what, freeBytes: event.freeBytes, totalBytes: event.totalBytes },
    };
};
