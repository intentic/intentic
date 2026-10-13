import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { RetentionSettings } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { TranscriptRetentionResult } from "../conversations/registry/transcript-retention.js";
import type { WorkspaceHistory } from "../history/history.js";
import type { PrivacyImageArchive } from "../privacy/privacy-images.js";
import type { PrivacyVault } from "../privacy/privacy-vault.js";
import { logsRoot } from "../seams/logs-root.js";
import { statePath } from "../state-paths.js";
import { DAY_MS } from "../system/chore-clock.js";
import { removeAgedFiles } from "./aged-files.js";

// THE DATA RETENTION SWEEP (2026-10-13): settings.retention made real. Each positive `*Days` DELETES the copies of one
// kind older than that many days, for good: nothing is archived or moved to a trash first, since a copy kept anywhere
// is a copy a person asked to be forgotten is still in. Every value is 0 by default, and 0 runs nothing, so a sandbox
// that never set one keeps everything as it always did. Each kind is applied by the code that owns its store:
// - transcripts: conversations/registry/transcript-retention.ts (a conversation and every copy of what was said in it)
// - restore points: history/restore-point-retention.ts (the workspace snapshots, cut with git's shallow boundary)
// - privacy vault: privacy/privacy-vault.ts `expire` (values not seen since), with the masked pictures beside it
// - caches: the converted documents, page renders and thumbnails under .intentic/local/cache, by write time
// - raw output: the untrimmed command output and the pane captures under /history/logs, by write time
// Each run answers what it deleted per kind (a RetentionPass), which is logged and handed to `record`, the seam an
// audit trail connects to.

export type RetentionKind = "transcripts" | "restorePoints" | "privacyVault" | "caches" | "rawOutput";

export const RETENTION_KINDS: readonly RetentionKind[] = ["transcripts", "restorePoints", "privacyVault", "caches", "rawOutput"];

// Which setting each kind reads.
const SETTING = {
    transcripts: "transcriptDays",
    restorePoints: "restorePointDays",
    privacyVault: "privacyVaultDays",
    caches: "cacheDays",
    rawOutput: "rawOutputDays",
} as const satisfies Record<RetentionKind, keyof RetentionSettings>;

export interface RetentionPass {
    readonly kind: RetentionKind;
    readonly days: number;
    // Epoch ms; what was older than this went.
    readonly before: number;
    // How many it deleted: conversations, snapshots, vault values and masked pictures, or files.
    readonly deleted: number;
    // Conversations kept this time because removing their checkout failed; the next run tries again.
    readonly failed?: number;
    // The deleted conversations' ids, for an audit record. Ids only: nothing they said.
    readonly ids?: readonly string[];
}

export interface RetentionDeps {
    readonly settings: () => Promise<RetentionSettings>;
    readonly now: () => number;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly transcripts: (now: number, maxAgeMs: number) => Promise<TranscriptRetentionResult>;
    readonly history: Pick<WorkspaceHistory, "prune">;
    readonly vault: Pick<PrivacyVault, "expire">;
    readonly images: Pick<PrivacyImageArchive, "expire">;
    // The folders `cacheDays` and `rawOutputDays` empty by age; read at each run, since overlays come and go.
    readonly cacheDirs: () => Promise<readonly string[]>;
    readonly rawOutputDirs: () => Promise<readonly string[]>;
    // Each pass that ran, as it finishes; where an audit trail is connected.
    readonly record?: (pass: RetentionPass) => void;
}

const sumAgedFiles = async (dirs: readonly string[], before: number): Promise<number> => {
    let deleted = 0;
    for (const dir of dirs) {
        deleted += await removeAgedFiles(dir, before);
    }
    return deleted;
};

const runKind = async (deps: RetentionDeps, kind: RetentionKind, days: number, now: number): Promise<RetentionPass> => {
    const before = now - days * DAY_MS;
    const base = { kind, days, before };
    switch (kind) {
        case "transcripts": {
            const { deleted, failed } = await deps.transcripts(now, days * DAY_MS);
            const pass: RetentionPass = { ...base, deleted: deleted.length, ids: deleted };
            return failed > 0 ? { ...pass, failed } : pass;
        }
        case "restorePoints":
            return { ...base, deleted: await deps.history.prune(before) };
        case "privacyVault":
            return { ...base, deleted: (await deps.vault.expire(new Date(before))) + (await deps.images.expire(new Date(before))) };
        case "caches":
            return { ...base, deleted: await sumAgedFiles(await deps.cacheDirs(), before) };
        case "rawOutput":
            return { ...base, deleted: await sumAgedFiles(await deps.rawOutputDirs(), before) };
    }
};

// Applies every positive setting among `kinds`; answers the passes that ran. One kind failing is logged and the rest
// still run.
export const runRetentionSweep = async (deps: RetentionDeps, kinds: readonly RetentionKind[] = RETENTION_KINDS): Promise<RetentionPass[]> => {
    const settings = await deps.settings();
    const now = deps.now();
    const passes: RetentionPass[] = [];
    for (const kind of kinds) {
        const days = settings[SETTING[kind]];
        if (days <= 0) {
            continue;
        }
        try {
            const pass = await runKind(deps, kind, days, now);
            passes.push(pass);
            deps.record?.(pass);
            if (pass.deleted > 0 || pass.failed !== undefined) {
                deps.logger.info({ retention: pass }, `retention: deleted ${String(pass.deleted)} past ${String(days)} days (${kind})`);
            }
        } catch (error) {
            deps.logger.warn({ err: error, kind, days }, "retention: a sweep failed, it runs again at the next one");
        }
    }
    return passes;
};

// The caches `cacheDays` ages: what fileq made of documents (text read out of PDFs and office files, OCR of scans,
// page renders) and the daemon's own renderings of conversation blobs and pictures. Models and indexes stay.
export const cacheDirsOf = (workspaceRoot: string): string[] =>
    ["derived", "derived-blobs", "rendered", "thumbnails"].map((name) => statePath(workspaceRoot, ".intentic/local/cache/", name));

// Where raw command output sits: the untrimmed output the output cleaners keep (raw-output), their repeat detector's
// copies (output-cache), the terminals' pane captures, and the same three in every fenced turn's overlay.
export const rawOutputDirsOf = async (historyRoot: string): Promise<string[]> => {
    const groups = ["raw-output", "output-cache", "terminals"];
    const overlays = (await readdir(join(historyRoot, "overlays")).catch(undefinedIfMissing)) ?? [];
    return [logsRoot(historyRoot), ...overlays.map((overlay) => join(historyRoot, "overlays", overlay, "logs"))].flatMap((root) =>
        groups.map((group) => join(root, group)),
    );
};
