import { LOCKED_STATE_ENTRIES, PLAN_DOCUMENTS_DIR, STATE_DIR } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { lockedFileEntries, lockedFile } from "./lockedFile";

describe(`lockedFile`, () => {
    /* THE ASSERTION THIS TABLE EXISTS FOR. */
    it(`has a sentence for every entry the contract locks`, () => {
        for (const entry of LOCKED_STATE_ENTRIES) {
            expect([entry, lockedFileEntries()[entry] !== undefined]).toEqual([entry, true]);
        }
    });

    it(`names the locked folder, not the leaf inside it`, () => {
        // A locked folder is one row in the explorer and never descended, so its leaves are names the reader
        // has never seen: "Cookies is kept private" is a true sentence about nothing.
        const cookies = lockedFile(`${STATE_DIR}/local/browser/Default/Cookies`);
        expect(cookies.subject).toBe(`${STATE_DIR}/local/browser`);
        expect(cookies.manage?.to).toBe(`/browsers`);
    });

    it(`sends a locked file to the screen that owns the thing inside it`, () => {
        expect(lockedFile(`${STATE_DIR}/config/capabilities.json`).manage).toEqual({ label: `Capabilities`, to: `/capabilities` });
        expect(lockedFile(`${STATE_DIR}/records/sessions/claude/projects/x.jsonl`).manage).toEqual({ label: `Agents`, to: `/agents` });
    });

    it(`falls back to the leaf for a path the rule does not hold`, () => {
        // Unreachable through the viewer, which resolves the same rule to get here; reachable by a pasted link.
        // A plan document is exactly that case now: it lives under a locked folder and is not itself locked.
        const plan = lockedFile(`${PLAN_DOCUMENTS_DIR}/wiggly-spring.md`);
        expect(plan.subject).toBe(`wiggly-spring.md`);
        expect(plan.manage).toBeUndefined();
    });
});
