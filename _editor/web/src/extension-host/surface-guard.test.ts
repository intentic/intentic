import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import * as sdkModule from "@intentic/extension-api";
import { extensionApiVersion } from "@intentic/extension-api";
import { CONTRIBUTION_POINTS, ExtensionManifestSchema, ListenerContributionSchema } from "@intentic/extension-manifest";
import { expect, test } from "vitest";

// extensionApiVersion is an author's only signal for host compatibility; the snapshot in surface.json fails when the
// live surface changes without a new versioned entry.
// Grain is top-level keys on purpose: an unknown key inside a contribution entry fails the parse loudly, but an unknown
// key at the top level is silently dropped.
// Lives in the web app, where the extension-contract conformance tests already run, since extension-api itself ships no
// test harness.

const sdkRoot = join(repoRoot(import.meta.url), `_shared/extension-api`);

interface RecordedSurface {
    readonly manifest: readonly string[];
    readonly contributes: readonly string[];
    readonly api: readonly string[];
    readonly listener?: readonly string[];
    // api.sandbox's own members, recorded from 2.3.0 on; optional since earlier entries predate it.
    readonly sandboxApi?: readonly string[];
    // api.workspace's own members, recorded from 2.10.0 on; a top-level record can't see additions inside workspace.
    readonly workspaceApi?: readonly string[];
    /* api.chat's own members, recorded from 2.11.0 on: `openAgent` was added there, and without a sub-surface
     * record the entry would be indistinguishable from its predecessor's. Optional because earlier entries
     * predate it. */
    readonly chatApi?: readonly string[];
    /* What the PACKAGE exports, recorded from 2.6.0 on: the third grain, and the last one that was still
     * unrecorded.
     *
     * `IntenticApi` is what an extension is HANDED, and everything above tracks it. But some of the contract
     * cannot be handed over, because it is needed before `activate(api)` has run: `hostSlot` binds the handle
     * itself, and `sandboxRef` declares module state at import time. Those are imported from the package, they
     * are every bit as breakable as a member of the api object, and nothing here could see them: `hostSlot`
     * arrived, and later so did the whole scope primitive, with no record either way. */
    readonly moduleExports?: readonly string[];
}

const recorded: Record<string, RecordedSurface> = JSON.parse(readFileSync(resolve(sdkRoot, `src/surface.json`), `utf8`));

// IntenticApi is a type, so its members are parsed from source text, not enumerated at runtime.
// Depth is inferred from indent: prettier holds this file at four spaces, so a top-level member is the only `readonly`
// at column 4.
const apiMembers = (): string[] => {
    const text = readFileSync(resolve(sdkRoot, `src/api.ts`), `utf8`);
    const start = text.indexOf(`export interface IntenticApi {`);
    const open = text.indexOf(`{`, start);
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i++) {
        if (text[i] === `{`) {
            depth++;
        } else if (text[i] === `}` && --depth === 0) {
            end = i;
            break;
        }
    }
    return [...text.slice(open + 1, end).matchAll(/^ {4}readonly (\w+)\??:/gm)].map((match) => match[1] ?? ``).toSorted();
};

// Members of one nested block of IntenticApi (e.g. sandbox), found the same way as apiMembers but one indent level
// deeper.
// Column 8 is where a block's own members sit, since prettier holds the file at four-space indents.
const nestedMembers = (block: string): string[] => {
    const text = readFileSync(resolve(sdkRoot, `src/api.ts`), `utf8`);
    const start = text.indexOf(`readonly ${block}: {`);
    const open = text.indexOf(`{`, start);
    let depth = 0;
    let end = text.length;
    for (let i = open; i < text.length; i++) {
        if (text[i] === `{`) {
            depth++;
        } else if (text[i] === `}` && --depth === 0) {
            end = i;
            break;
        }
    }
    return [...text.slice(open + 1, end).matchAll(/^ {8}(?:readonly )?(\w+)\??[(:<]/gm)].map((match) => match[1] ?? ``).toSorted();
};

const liveSurface = (): RecordedSurface => ({
    manifest: Object.keys(ExtensionManifestSchema.shape).toSorted(),
    // Read off the registry, not the schema: a broken point then shows as missing here, not invisible everywhere.
    contributes: CONTRIBUTION_POINTS.map((point) => point.name).toSorted(),
    api: apiMembers(),
    listener: Object.keys(ListenerContributionSchema.shape).toSorted(),
    sandboxApi: nestedMembers(`sandbox`),
    workspaceApi: nestedMembers(`workspace`),
    chatApi: nestedMembers(`chat`),
    // The runtime exports only. Types are the api object's business (recorded above) and a package that
    // re-exports thirty interfaces would drown the one line that says a new FUNCTION arrived.
    moduleExports: Object.keys(sdkModule)
        .filter((name) => typeof (sdkModule as Record<string, unknown>)[name] === `function` || name === `extensionApiVersion`)
        .toSorted(),
});

test(`the surface this version promises is the surface it has`, () => {
    // A failure means either the surface changed (bump extensionApiVersion and add an entry for the new version)
    // or the version was bumped without recording it (copy the received value in as that entry).
    expect(recorded[extensionApiVersion]).toEqual(liveSurface());
});

test(`every earlier version keeps its own record`, () => {
    // surface.json ships with the package as the SDK's surface history, so a pinned author can see what their version
    // actually had.
    // No two versions may record the same surface; rewriting an old entry would mean one of them lies about what
    // changed.
    const shapes = Object.values(recorded).map((surface) => JSON.stringify(surface));
    expect(new Set(shapes).size).toBe(shapes.length);
});

test(`the SDK README names exactly the contribution points the schema has`, () => {
    // The README's list is what an author reads before the schema; it must not silently go stale.
    const readme = readFileSync(resolve(sdkRoot, `README.md`), `utf8`);
    const sentence = /Contribution points:([\s\S]*?), plus the/.exec(readme);
    expect(sentence).not.toBeNull();
    const named = [...(sentence?.[1] ?? ``).matchAll(/`(\w+)`/g)].map((match) => match[1] ?? ``).toSorted();
    expect(named).toEqual(liveSurface().contributes);
});

test(`every file the SDK README points at exists`, () => {
    // Catches a stale relative link in the README: it still renders as valid markdown and only fails for the reader
    // when a linked file moves.
    // Anchors and external URLs are skipped; only relative file links, which can actually rot, are checked.
    const readme = readFileSync(resolve(sdkRoot, `README.md`), `utf8`);
    const links = [...readme.matchAll(/\]\(([^)]+)\)/gu)]
        .map((match) => (match[1] ?? ``).split(`#`)[0] ?? ``)
        .filter((target) => target !== `` && !/^[a-z]+:/u.test(target));
    const broken = links.filter((target) => !existsSync(resolve(sdkRoot, target)));
    expect(broken).toEqual([]);
});
