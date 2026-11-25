import { type DeployOutcome, type DeployRecord, DeployRecordSchema } from "@intentic/sandbox-contract/schemas/deploys";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// EVERY DEPLOY OF A MANAGED STACK (schemas/deploys.ts DeployRecordSchema), by id, one entry each parsed on its own so a
// record a later release wrote costs itself and never the rest. The waiting ones are the engine's durable queue: a
// restart finds them here and runs them (deploys-engine.ts). Secret NAMES only, never a value, and what the machine
// printed is masked before it lands here (deploy-render.ts maskedText), since agents read this folder.

export const deploysDocument = defineDocument({ path: stateRelPath(".intentic/records/deploys.json"), schema: DeployRecordSchema, granularity: "record" });

// Ended records kept per stack, newest first: what the board's history and a rollback reach back to. A queued or
// running one is never dropped.
const KEPT_PER_STACK = 50;

const LIVE_OUTCOMES: readonly DeployOutcome[] = new Set(["queued", "running"]);
export const isLive = (record: Pick<DeployRecord, "outcome">): boolean => LIVE_OUTCOMES.has(record.outcome);

// A stack's key across repositories.
export const stackKey = (repo: string, stack: string): string => `${repo}\u0000${stack}`;

// Newest first: by when each was queued, then by id, which the engine mints in time order (deploys-engine.ts recordId).
export const newestFirst = (left: DeployRecord, right: DeployRecord): number =>
    right.queuedAt.localeCompare(left.queuedAt) || right.id.localeCompare(left.id);

type RecordsFile = Readonly<Record<string, DeployRecord>>;

// Each stack's ended records past its keep, dropped.
const trimmed = (records: RecordsFile): RecordsFile => {
    const seen = new Map<string, number>();
    const dropped = new Set<string>();
    for (const record of Object.values(records).toSorted(newestFirst)) {
        if (isLive(record)) {
            continue;
        }
        const key = stackKey(record.repo, record.stack);
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > KEPT_PER_STACK) {
            dropped.add(record.id);
        }
    }
    return dropped.size === 0 ? records : Object.fromEntries(Object.entries(records).filter(([id]) => !dropped.has(id)));
};

export interface DeploysStore {
    // Newest first.
    readonly all: () => Promise<readonly DeployRecord[]>;
    readonly get: (id: string) => Promise<DeployRecord | undefined>;
    // Writes one record whole; when it is queued, every other record of its stack still queued is marked superseded by
    // it in the same write, and those are answered, as they now stand.
    readonly put: (record: DeployRecord, supersede?: (waiting: DeployRecord) => DeployRecord) => Promise<readonly DeployRecord[]>;
    // Changes one record in place; undefined when there is none, and the change is not called.
    readonly update: (id: string, change: (record: DeployRecord) => DeployRecord) => Promise<DeployRecord | undefined>;
}

// The whole file as the store reads and writes it; openDocument's JsonFile satisfies it.
interface RecordsFileAccess {
    readonly read: () => Promise<RecordsFile>;
    readonly update: (change: (current: RecordsFile) => RecordsFile) => Promise<RecordsFile>;
}

const deploysStoreOver = (file: RecordsFileAccess): DeploysStore => ({
    all: async () => Object.values(await file.read()).toSorted(newestFirst),
    get: async (id) => (await file.read())[id],
    put: async (record, supersede) => {
        const replaced: DeployRecord[] = [];
        await file.update((current) => {
            const waiting =
                record.outcome === "queued" && supersede !== undefined
                    ? Object.values(current).filter(
                          (held) => held.outcome === "queued" && held.id !== record.id && held.repo === record.repo && held.stack === record.stack,
                      )
                    : [];
            const ended = waiting.map((held) => supersede?.(held) ?? held);
            replaced.push(...ended);
            return trimmed({ ...current, ...Object.fromEntries(ended.map((entry) => [entry.id, entry])), [record.id]: record });
        });
        return replaced;
    },
    update: async (id, change) => {
        let changed: DeployRecord | undefined;
        await file.update((current) => {
            const record = current[id];
            if (record === undefined) {
                return current;
            }
            changed = change(record);
            return trimmed({ ...current, [id]: changed });
        });
        return changed;
    },
});

export const fileDeploysStore = (path: string): DeploysStore => deploysStoreOver(openDocument(deploysDocument, path, { fallback: (): RecordsFile => ({}) }));
