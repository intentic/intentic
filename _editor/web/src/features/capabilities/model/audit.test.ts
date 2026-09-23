// Pins when the form offers an agent's read of an extension (only once a commit is pinned), when that read is of what
// changed rather than the whole tree (an edit moving the pin), and the brief each one hands the agent.
import type { CapabilitySummary } from "@intentic/api-contract";
import { updateBrief } from "@intentic/sandbox-contract/chores";
import { describe, expect, it } from "bun:test";
import { auditBrief } from "../../sandbox/extensions/extensionBrief";
import { auditOffered, auditPrompt, replacedPin } from "./audit";

const HEAD = `a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`;
const OLD = `9999999999999999999999999999999999999999`;
const pinned = { url: `https://github.com/acme/ext`, ref: HEAD, path: `` };
const installed = (ref: string): CapabilitySummary => ({
    id: `ext`,
    kind: `extension`,
    status: { state: `active` },
    config: { url: pinned.url, ref },
    secrets: [],
});

describe(`the offer to read an extension first`, () => {
    it(`stands once an extension's form pins a whole commit of a repository`, () => {
        expect(auditOffered(`extension`, pinned)).toBe(true);
        expect(auditOffered(`extension`, { ...pinned, ref: `main` })).toBe(false);
        expect(auditOffered(`extension`, { ...pinned, url: `` })).toBe(false);
        expect(auditOffered(`plugin`, pinned)).toBe(false);
        expect(auditOffered(undefined, pinned)).toBe(false);
    });

    it(`reads what changed when an edit moves the pin, and the whole tree otherwise`, () => {
        expect(replacedPin(`extension`, installed(OLD), pinned)).toBe(OLD);
        expect(replacedPin(`extension`, installed(HEAD), pinned)).toBeUndefined();
        expect(replacedPin(`extension`, undefined, pinned)).toBeUndefined();
        // An install pinned to a branch name holds no commit to diff from.
        expect(replacedPin(`extension`, installed(`main`), pinned)).toBeUndefined();
        // No read offered, so nothing to read a diff of.
        expect(replacedPin(`extension`, installed(OLD), { ...pinned, ref: `main` })).toBeUndefined();
    });
});

describe(`the agent's brief`, () => {
    it(`names the install by its typed name, or by its repository when none was typed`, () => {
        expect(auditPrompt(` my-ext `, pinned, undefined)).toBe(auditBrief({ label: `my-ext`, url: pinned.url, ref: HEAD, path: `` }));
        expect(auditPrompt(``, { ...pinned, path: `packages/ext` }, undefined)).toBe(
            auditBrief({ label: pinned.url, url: pinned.url, ref: HEAD, path: `packages/ext` }),
        );
    });

    it(`asks for the change from the replaced commit on an update`, () => {
        expect(auditPrompt(`my-ext`, pinned, OLD)).toBe(updateBrief({ label: `my-ext`, url: pinned.url, path: ``, fromRef: OLD, toRef: HEAD }));
    });
});
