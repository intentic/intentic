import { describe, expect, it } from "vitest";
import { staleQueryKeys, WORKSPACE_STATE_FILES } from "./workspace-state.js";

describe(`staleQueryKeys`, () => {
    it(`maps a manifest write to the queries it makes stale`, () => {
        expect(staleQueryKeys([`.intentic/capabilities.json`])).toEqual([`capabilities`, `environment`, `panels`]);
        expect(staleQueryKeys([`.intentic/automations.json`])).toEqual([`automations`]);
    });

    it(`matches a name family and a one-file-per-entry directory through one prefix each`, () => {
        // environment.Dockerfile, environment.custom.Dockerfile, environment.approved.Dockerfile — one entry.
        expect(staleQueryKeys([`.intentic/environment.custom.Dockerfile`])).toEqual([`environment`]);
        expect(staleQueryKeys([`.intentic/approvals/a1.json`])).toEqual([`automation-approvals`]);
    });

    it(`refreshes the Drafts view when the AGENT writes a draft`, () => {
        // The regression this table was reorganized around: the drafts skill writes these files directly, so
        // there is no browser mutation to hang an invalidate on — the watcher push is the only signal, and it
        // used to be dropped on the floor.
        expect(staleQueryKeys([`.intentic/drafts/post-1.json`])).toEqual([`drafts`]);
    });

    it(`ignores unrelated churn under .intentic/`, () => {
        // The amplification that turned an iq index rebuild into an endless request storm: a prefix test on
        // `.intentic/` alone would invalidate every one of these queries for each index write.
        expect(staleQueryKeys([`.intentic/iq/index.db`, `.intentic/claude/projects/p/session.jsonl`])).toEqual([]);
    });

    it(`ignores a store's own temp file while it is mid-swap`, () => {
        // jsonFile writes `.<name>.<pid>.tmp` beside the target precisely so the atomic rename can't be read as
        // a write to the target itself. A trailing-tag temp would prefix-match and bill an extra refetch.
        expect(staleQueryKeys([`.intentic/.settings.json.42.tmp`])).toEqual([]);
        expect(staleQueryKeys([`.intentic/settings.json`])).toEqual([`settings`]);
    });

    it(`ignores ordinary workspace edits`, () => {
        expect(staleQueryKeys([`src/main.ts`, `README.md`])).toEqual([]);
    });

    it(`dedupes keys across a batch that touches several manifests`, () => {
        // A capability add recomposes the overlay, so both entries claim `environment` — one refetch, not two.
        expect(staleQueryKeys([`.intentic/capabilities.json`, `.intentic/environment.Dockerfile`])).toEqual([
            `capabilities`,
            `environment`,
            `panels`,
        ]);
    });
});

describe(`WORKSPACE_STATE_FILES`, () => {
    it(`declares every entry under .intentic/, root-relative and forward-slash`, () => {
        for (const file of WORKSPACE_STATE_FILES) {
            expect(file.path.startsWith(`.intentic/`), file.path).toBe(true);
            expect(file.path.includes(`\\`), file.path).toBe(false);
        }
    });

    it(`states a reason for every entry that invalidates nothing`, () => {
        // An empty `invalidates` is a real answer (daemon machine state, a deliberately-polled surface), but a
        // SILENT one is indistinguishable from the omission this table exists to prevent — which is exactly how
        // drafts went missing. Requiring the reason is what makes the difference visible at review time.
        for (const file of WORKSPACE_STATE_FILES) {
            if (file.invalidates.length === 0) {
                expect(file.why, `${file.path} invalidates nothing and must say why`).toBeTruthy();
            } else {
                expect(file.why, `${file.path} invalidates queries, so \`why\` is dead weight`).toBeUndefined();
            }
        }
    });

    it(`keeps directory entries slash-terminated so they cannot swallow a sibling`, () => {
        // `.intentic/drafts` without the slash would also prefix-match a future `.intentic/drafts-archive.json`.
        for (const file of WORKSPACE_STATE_FILES.filter((entry) => entry.invalidates.length > 0)) {
            const isFamilyPrefix = file.path.endsWith(`.`);
            const isFile = file.path.endsWith(`.json`) || file.path.endsWith(`.Dockerfile`);
            expect(isFile || isFamilyPrefix || file.path.endsWith(`/`), file.path).toBe(true);
        }
    });

    it(`has no entry that prefix-matches another, so one write can't be billed twice`, () => {
        for (const file of WORKSPACE_STATE_FILES) {
            const overlapping = WORKSPACE_STATE_FILES.filter((other) => other !== file && other.path.startsWith(file.path));
            expect(overlapping.map((other) => other.path), `${file.path} is a prefix of another entry`).toEqual([]);
        }
    });
});
