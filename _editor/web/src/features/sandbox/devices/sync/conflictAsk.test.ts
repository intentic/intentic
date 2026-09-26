import type { DeviceConflict } from "@intentic/sandbox-contract";
import { conflictAsk, type ConflictSubject } from "./conflictAsk";

// A turn started from a button is unwatched, so what it's told is the whole feature: each assertion is a way
// the turn would waste itself without that fact.

const subject = (over: Partial<ConflictSubject> = {}): ConflictSubject => ({
    machine: `radarsu-rog`,
    card: `radarsu-rog`,
    environment: `native`,
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

    it(`says what happened on each side, in the machine's own name rather than in "here"`, () => {
        const { prompt } = conflictAsk(subject());
        expect(prompt).toContain(`changed on radarsu-rog, changed in the sandbox`);
        expect(prompt).toContain(`deleted on radarsu-rog, changed in the sandbox`);
        expect(prompt).not.toContain(`changed here`);
    });

    it(`names the device's own tool namespace, because those tools are deferred until asked for`, () => {
        expect(conflictAsk(subject({ card: `ada-laptop` })).prompt).toContain(`+mcp__ada-laptop__`);
    });

    // A distro's folder is reached through its PC's own tools, with the crossing named.
    it(`sends a turn about a distro's folder through the card's tools, crossing into that distro`, () => {
        const { prompt } = conflictAsk(subject({ card: `ada-laptop`, environment: `wsl:archlinux` }));
        expect(prompt).toContain(`+mcp__ada-laptop__`);
        expect(prompt).toContain(`in: "wsl:archlinux"`);
    });

    // A turn sent to read both copies of a `node_modules` proves only that nobody wrote either. The button beside this
    // one clears those, and the machine's own agent clears them unprompted, so they are kept out of the prompt.
    it(`leaves out a directory stuck only on this device's build output`, () => {
        const { prompt } = conflictAsk(
            subject({
                conflicts: 2,
                conflictedPaths: [
                    { path: `src/app.ts`, local: `modified`, sandbox: `modified`, nature: `both-edited` },
                    { path: `intentic/_extensions/acceptance`, local: `untracked`, sandbox: `deleted`, nature: `derived-leftover` },
                ],
            }),
        );
        expect(prompt).toContain(`src/app.ts`);
        expect(prompt).not.toContain(`intentic/_extensions/acceptance`);
    });

    // An agent older than the classification reports no nature at all, and everything it sends must still reach a
    // person: absence of evidence is never read as "this one is only build output".
    it(`keeps an unclassified conflict, since nothing may be dropped on the strength of silence`, () => {
        const { prompt } = conflictAsk(subject({ conflicts: 1, conflictedPaths: [{ path: `src/app.ts`, local: `created`, sandbox: `created` }] }));
        expect(prompt).toContain(`src/app.ts`);
    });

    // The one thing that reads wrong from an isolated conversation: /work is its own worktree, not the shared tree
    // the device syncs with.
    it(`says which tree the sandbox's side actually is`, () => {
        const { prompt } = conflictAsk(subject());
        expect(prompt).toContain(`/mnt/intentic-main`);
        expect(prompt).toContain(`worktree`);
    });

    it(`counts what the report could not carry, so the turn does not stop at the paths it was given`, () => {
        const conflictedPaths: DeviceConflict[] = Array.from({ length: 6 }, (_, at) => ({ path: `f-${at}.ts` }));
        const { prompt } = conflictAsk(subject({ conflicts: 40, conflictedPaths }));
        expect(prompt).toContain(`40 file-sync conflicts`);
        expect(prompt).toContain(`…and 34 more`);
        expect(prompt).toContain(`mutagen sync list`);
        expect(prompt).not.toContain(`intentic-machine status`);
    });

    // An old agent reports a count and no paths; its own `status` predates printing them too, so the turn is sent
    // to Mutagen instead.
    it(`sends the turn to Mutagen itself when the report carried no paths at all`, () => {
        const { prompt } = conflictAsk(subject({ conflicts: 10, conflictedPaths: [] }));
        expect(prompt).toContain(`too old to report which paths`);
        expect(prompt).toContain(`mutagen sync list`);
        expect(prompt).toContain(`/home/radarsu/intentic/radarsu-local-0738cd6b5027`);
    });

    // The prompt must not read as permission to tidy up broadly: it has write tools loose in the machine's home
    // directory.
    it(`bounds the turn to the paths on the list, and to reading before writing`, () => {
        const { prompt } = conflictAsk(subject());
        expect(prompt).toContain(`touch only paths that are actually in conflict`);
        expect(prompt).toContain(`read both copies of a path before you write`);
        expect(prompt).toContain(`ask rather than picking a winner`);
    });

    it(`forbids the two switches that hide a conflict instead of ending it`, () => {
        expect(conflictAsk(subject()).prompt).toContain(`Do not pause, resume or unpair the sync`);
    });

    it(`says one conflict as one, since a badge reading "1 conflicts" is how a reader learns to distrust it`, () => {
        const { prompt } = conflictAsk(subject({ conflicts: 1, conflictedPaths: [{ path: `a.ts` }] }));
        expect(prompt).toContain(`the file-sync conflict between`);
    });
});
