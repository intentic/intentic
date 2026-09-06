import type { DeviceConflict } from "@intentic/sandbox-contract";
import { describe, expect, it } from "vitest";
import { conflictAsk, type ConflictSubject } from "./conflictAsk";

/* A turn started from a button is a turn nobody watched being written, so what it is TOLD is the whole of the
 * feature. Each assertion here is a way the turn would waste itself: it cannot open a file it was not told the
 * path of, it cannot reach a machine it was not told the tool namespace of, and a turn told about six of forty
 * conflicts would fix six and report the job done. */

const subject = (over: Partial<ConflictSubject> = {}): ConflictSubject => ({
    machine: `radarsu-rog`,
    hostId: `radarsu-rog`,
    localDir: `/home/radarsu/intentic/radarsu-local-0738cd6b5027`,
    conflicts: 2,
    conflictedPaths: [
        { path: `src/app.ts`, local: `modified`, sandbox: `modified` },
        { path: `docs/notes.md`, local: `deleted`, sandbox: `modified` },
    ],
    ...over,
});

describe(`conflictAsk`, () => {
    it(`names both ends of the sync: the machine, its folder, and every stuck path`, () => {
        const { prompt } = conflictAsk(subject());
        expect(prompt).toContain(`radarsu-rog`);
        expect(prompt).toContain(`/home/radarsu/intentic/radarsu-local-0738cd6b5027`);
        expect(prompt).toContain(`src/app.ts`);
        expect(prompt).toContain(`docs/notes.md`);
    });

    // Which side did what is what decides which copy survives, and it is free: the machine already reported it.
    it(`says what happened on each side, in the machine's own name rather than in "here"`, () => {
        const { prompt } = conflictAsk(subject());
        expect(prompt).toContain(`changed on radarsu-rog, changed in the sandbox`);
        expect(prompt).toContain(`deleted on radarsu-rog, changed in the sandbox`);
        expect(prompt).not.toContain(`changed here`);
    });

    /* The tools that reach that computer are DEFERRED: their schemas are not in the turn's prompt until it goes
     * and gets them, so a prompt that says "read the file on their laptop" without naming the namespace has
     * pointed an agent at a machine it has no way to call. */
    it(`names the device's own tool namespace, because those tools are deferred until asked for`, () => {
        expect(conflictAsk(subject({ hostId: `ada-laptop` })).prompt).toContain(`+mcp__ada-laptop__`);
    });

    /* The one thing about this job that reads wrong from inside an isolated conversation: /work is that
     * conversation's own worktree, and the folder the session syncs is the shared tree. A turn that "resolved"
     * the conflicts inside its worktree would change neither end and report success. */
    it(`says which tree the sandbox's side actually is`, () => {
        const { prompt } = conflictAsk(subject());
        expect(prompt).toContain(`/mnt/intentic-main`);
        expect(prompt).toContain(`worktree`);
    });

    /* A turn told about six of forty would fix six and report the job done, so the remainder is stated with
     * somewhere to go — Mutagen, not this machine's `status`, which caps its own output the same way. */
    it(`counts what the report could not carry, so the turn does not stop at the paths it was given`, () => {
        const conflictedPaths: DeviceConflict[] = Array.from({ length: 6 }, (_, at) => ({ path: `f-${at}.ts` }));
        const { prompt } = conflictAsk(subject({ conflicts: 40, conflictedPaths }));
        expect(prompt).toContain(`40 file-sync conflicts`);
        expect(prompt).toContain(`…and 34 more`);
        expect(prompt).toContain(`mutagen sync list`);
        expect(prompt).not.toContain(`intentic-machine status`);
    });

    /* An agent old enough to report a count and not the paths is a real row on this tab, and the turn it starts
     * has to be told where to go and look. Not at that agent's own `status`, which predates printing them too
     * and would hand the turn back the number it started with: at Mutagen, which is the source under both. */
    it(`sends the turn to Mutagen itself when the report carried no paths at all`, () => {
        const { prompt } = conflictAsk(subject({ conflicts: 10, conflictedPaths: [] }));
        expect(prompt).toContain(`too old to report which paths`);
        expect(prompt).toContain(`mutagen sync list`);
        expect(prompt).toContain(`/home/radarsu/intentic/radarsu-local-0738cd6b5027`);
    });

    /* The prompt must not read as permission to tidy up on somebody's laptop: it is loose in their home
     * directory with write tools, and none of what it does there is reviewable as a diff afterwards. */
    it(`bounds the turn to the paths on the list, and to reading before writing`, () => {
        const { prompt } = conflictAsk(subject());
        expect(prompt).toContain(`touch only paths that are actually in conflict`);
        expect(prompt).toContain(`read both copies of a path before you write`);
        expect(prompt).toContain(`ask rather than picking a winner`);
    });

    // Pausing or unpairing makes the badge go away without resolving anything, which is the one "fix" this turn
    // must never reach for.
    it(`forbids the two switches that hide a conflict instead of ending it`, () => {
        expect(conflictAsk(subject()).prompt).toContain(`Do not pause, resume or unpair the sync`);
    });

    it(`says one conflict as one, since a badge reading "1 conflicts" is how a reader learns to distrust it`, () => {
        const { prompt } = conflictAsk(subject({ conflicts: 1, conflictedPaths: [{ path: `a.ts` }] }));
        expect(prompt).toContain(`the file-sync conflict between`);
    });
});
