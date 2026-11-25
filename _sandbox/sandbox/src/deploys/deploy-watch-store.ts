import { StackHealthStateSchema } from "@intentic/sandbox-contract/schemas/deploys";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// WHAT THE WATCH REMEMBERS ACROSS A RESTART (deploy-watch.ts): what the monitor last read of each managed stack and what
// the owner was last told of it, which disks and memory of each server are low right now, when each registry trigger
// last pulled, and the forge's deployment for each record it reported. So a restart neither alerts again about a stack
// already said to be unhealthy, nor pulls every stack at once, nor loses the GitHub deployment a record's end goes to.
// Facts about the stacks and servers only: no secret, no value.

const WatchedStackSchema = z.object({
    repo: z.string(),
    stack: z.string(),
    // The last state read, since when it has read so, and how many reads in a row said it.
    state: StackHealthStateSchema,
    since: z.string(),
    reads: z.number().int().nonnegative(),
    // What the owner was last told: nothing or that it recovered (`ok`), or that it is unhealthy (`bad`).
    told: z.enum(["ok", "bad"]),
});
export type WatchedStack = z.infer<typeof WatchedStackSchema>;

const WatchedHostSchema = z.object({
    device: z.string(),
    // What is low on it now, each told once when it went low: `memory`, or `disk:<path>`.
    low: z.array(z.string()),
});
export type WatchedHost = z.infer<typeof WatchedHostSchema>;

const RegistryCheckSchema = z.object({ repo: z.string(), stack: z.string(), checkedAt: z.string() });
export type RegistryCheck = z.infer<typeof RegistryCheckSchema>;

const ForgeReportSchema = z.object({
    // The deploy record.
    id: z.string(),
    // GitHub's deployment for it, which each later status goes to.
    deployment: z.number().optional(),
    // The last state the forge was told (GitHub's or GitLab's own word).
    reported: z.string(),
});
export type ForgeReport = z.infer<typeof ForgeReportSchema>;

export const DeployWatchFileSchema = z.object({
    stacks: z.array(WatchedStackSchema).default([]),
    hosts: z.array(WatchedHostSchema).default([]),
    registry: z.array(RegistryCheckSchema).default([]),
    forge: z.array(ForgeReportSchema).default([]),
});
export type DeployWatchFile = z.infer<typeof DeployWatchFileSchema>;

export const deployWatchDocument = defineDocument({
    root: "history",
    path: "deploy-watch.json",
    // What this daemon saw and said: a moved sandbox reads every stack afresh, and alerts once more what is still wrong.
    portability: "derived",
    schema: DeployWatchFileSchema,
});

// The forge reports kept: enough for every record still live, oldest dropped first.
export const FORGE_REPORTS_KEPT = 200;

export interface DeployWatchStore {
    readonly read: () => Promise<DeployWatchFile>;
    // Read-change-write, serialized against every other change of the file.
    readonly update: (change: (current: DeployWatchFile) => DeployWatchFile) => Promise<DeployWatchFile>;
}

const empty = (): DeployWatchFile => ({ stacks: [], hosts: [], registry: [], forge: [] });

// On the history volume, the daemon's own; a file this build cannot read is set aside and grown again, at the cost of one
// alert or pull more.
export const fileDeployWatch = (path: string): DeployWatchStore => {
    const file = openDocument(deployWatchDocument, path, { fallback: empty });
    return { read: () => file.read(), update: (change) => file.update(change) };
};
