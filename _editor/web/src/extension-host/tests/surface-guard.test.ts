import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import * as sdkModule from "@intentic/extension-api";
import { extensionApiVersion } from "@intentic/extension-api";
import { extensionUiDeprecated, extensionUiNames } from "@intentic/extension-ui/names";
import {
    CONTRIBUTION_POINTS,
    ExtensionManifestSchema,
    ListenerContributionSchema,
    manifestJsonSchema,
    serializeManifestJsonSchema,
} from "@intentic/extension-manifest";

// extensionApiVersion is an author's only signal for host compatibility; the snapshot in surface.json fails when the
// live surface changes without a new versioned entry.
// The key grains name what was added; from 2.20.0 a digest of the whole generated manifest schema stands behind them,
// since the runtime parse drops a key it does not know at ANY depth, so a field added inside an entry is as silent to
// an older host as one at the top level.
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
    /* api.chat's own members, recorded from 2.11.0 on: `openAgent` was added there. */
    readonly chatApi?: readonly string[];
    // The backend api's `daemon` members (server.ts), recorded from 2.17.0 on: `rpc` was added there.
    readonly daemonApi?: readonly string[];
    // The backend api's own members (server.ts), recorded from 2.20.0 on: `tools` was added there.
    readonly serverApi?: readonly string[];
    // ToolDefinition's own fields (server.ts), recorded from 2.21.0 on: `effect` was added there.
    readonly toolDefinition?: readonly string[];
    // api.sideViews' own members and SideViewRegistration's own fields, recorded from 2.22.0 on, where the side panel's
    // surface arrived and will grow.
    readonly sideViewsApi?: readonly string[];
    readonly sideViewRegistration?: readonly string[];
    // ViewRegistration's own fields, recorded from 2.23.0 on: `asks` was added there.
    readonly viewRegistration?: readonly string[];
    // The backend api's `settings` and `workspace` members (server.ts), recorded from 2.26.0 on, where both arrived.
    readonly serverSettingsApi?: readonly string[];
    readonly serverWorkspaceApi?: readonly string[];
    // sha256 of the generated authoring schema, recorded from 2.20.0 on: any change to the manifest at any depth.
    readonly manifestSchema?: string;
    /* What the PACKAGE exports, recorded from 2.6.0 on: the third grain, and the last one that was still unrecorded. */
    readonly moduleExports?: readonly string[];
    // What @intentic/extension-ui exports (names.mjs, the list its shim re-exports), recorded from 2.31.0 on: a bundle
    // links these by name as it does the package's own, and RepoRail left them on 2026-10-12 with nothing recording it.
    readonly uiKitExports?: readonly string[];
}

const recorded: Record<string, RecordedSurface> = JSON.parse(readFileSync(resolve(sdkRoot, `src/surface.json`), `utf8`));

// IntenticApi is a type, so its members are parsed from source text, not enumerated at runtime.
// Depth is inferred from indent: prettier holds this file at four spaces, so a top-level member is the only `readonly`
// at column 4.
const apiMembers = (file = `src/api.ts`, anchor = `export interface IntenticApi {`): string[] => {
    const text = readFileSync(resolve(sdkRoot, file), `utf8`);
    const start = text.indexOf(anchor);
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

// Members of one nested block of an api interface (e.g. IntenticApi's sandbox), found the same way as apiMembers but one
// indent level deeper. Column 8 is where a block's own members sit, since prettier holds the file at four-space indents.
const nestedMembers = (block: string, file = `src/api.ts`): string[] => {
    const text = readFileSync(resolve(sdkRoot, file), `utf8`);
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
    daemonApi: nestedMembers(`daemon`, `src/server.ts`),
    serverApi: apiMembers(`src/server.ts`, `export interface ExtensionServerApi {`),
    toolDefinition: apiMembers(`src/server.ts`, `export interface ToolDefinition {`),
    sideViewsApi: nestedMembers(`sideViews`),
    sideViewRegistration: apiMembers(`src/api.ts`, `export interface SideViewRegistration {`),
    viewRegistration: apiMembers(`src/api.ts`, `export interface ViewRegistration {`),
    serverSettingsApi: nestedMembers(`settings`, `src/server.ts`),
    serverWorkspaceApi: nestedMembers(`workspace`, `src/server.ts`),
    manifestSchema: createHash(`sha256`).update(serializeManifestJsonSchema(manifestJsonSchema())).digest(`hex`),
    // The runtime exports only. Types are the api object's business (recorded above) and a package that
    // re-exports thirty interfaces would drown the one line that says a new FUNCTION arrived. A namespace of functions
    // (`conversions`, 2.19.0) is a set of functions arriving under one name, so an object counts too.
    moduleExports: Object.keys(sdkModule)
        .filter((name) => {
            const value = (sdkModule as Record<string, unknown>)[name];
            return typeof value === `function` || (typeof value === `object` && value !== null) || name === `extensionApiVersion`;
        })
        .toSorted(),
    uiKitExports: [...extensionUiNames].toSorted(),
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

// The names a bundle links against are held to semver, which the grains above are not: a version that adds one is at
// least a minor, one that drops one is a major, and only a name declared deprecated may go, at or past its floor. Then
// `engines.intentic` alone keeps an extension off a host that lacks a name it was built with, before its link fails.
interface Deprecation {
    readonly name: string;
    readonly removableIn: string;
}

const semver = (version: string): readonly [number, number, number] => {
    const [major = 0, minor = 0, patch = 0] = version.split(`.`).map(Number);
    return [major, minor, patch];
};
const byVersion = (a: string, b: string): number => {
    const [x, y] = [semver(a), semver(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const majorStep = (from: string, to: string): boolean => semver(to)[0] > semver(from)[0];
const minorStep = (from: string, to: string): boolean =>
    majorStep(from, to) || (semver(to)[0] === semver(from)[0] && semver(to)[1] > semver(from)[1]);

// What is wrong with one linked-name grain: the live names against what `version` records, and every step between two
// recorded versions. Empty when the record is honest. `history` maps a version to its names, absent before the grain
// was recorded.
const linkedNameProblems = (
    history: Readonly<Record<string, readonly string[] | undefined>>,
    version: string,
    live: readonly string[],
    deprecated: readonly Deprecation[],
): string[] => {
    const problems: string[] = [];
    const floors = new Map(deprecated.map((entry) => [entry.name, entry.removableIn]));
    const recordedNow = new Set(history[version] ?? []);
    const liveNames = new Set(live);
    const joined = live.filter((name) => !recordedNow.has(name));
    if (joined.length > 0) {
        problems.push(`${joined.join(`, `)} joined without a version: an addition moves extensionApiVersion a minor, recorded in surface.json`);
    }
    for (const name of [...recordedNow].filter((entry) => !liveNames.has(entry))) {
        const floor = floors.get(name);
        problems.push(
            floor === undefined
                ? `${name} left, and every extension importing it would stop loading: put it back, or declare it deprecated and drop it in a major`
                : `${name} left: dropping a deprecated name moves extensionApiVersion a major, at ${floor} or later, recorded in surface.json`,
        );
    }
    const versions = Object.keys(history)
        .filter((entry) => history[entry] !== undefined)
        .toSorted(byVersion);
    for (const [index, next] of versions.entries()) {
        const previous = versions[index - 1];
        if (previous === undefined) {
            continue;
        }
        const [before, after] = [new Set(history[previous]), new Set(history[next])];
        const added = [...after].filter((name) => !before.has(name));
        if (added.length > 0 && !minorStep(previous, next)) {
            problems.push(`${next} adds ${added.join(`, `)} in a patch over ${previous}: an addition is a minor`);
        }
        for (const name of [...before].filter((entry) => !after.has(entry))) {
            const floor = floors.get(name);
            if (floor === undefined) {
                problems.push(`${next} drops ${name}, which was never declared deprecated`);
            } else if (!majorStep(previous, next)) {
                problems.push(`${next} drops ${name} outside a major`);
            } else if (byVersion(next, floor) < 0) {
                problems.push(`${next} drops ${name} before ${floor}, the floor its deprecation set`);
            }
        }
    }
    const known = new Set([...live, ...versions.flatMap((entry) => history[entry] ?? [])]);
    for (const entry of deprecated.filter((candidate) => !known.has(candidate.name))) {
        problems.push(`${entry.name} is declared deprecated, and no recorded version has it`);
    }
    return problems;
};

const grain = (key: `moduleExports` | `uiKitExports`): Record<string, readonly string[] | undefined> =>
    Object.fromEntries(Object.entries(recorded).map(([version, surface]) => [version, surface[key]]));

// This package's own exports retire the same way, declared here first (none is yet).
const apiDeprecated: readonly Deprecation[] = [];

test(`the names a bundle links against move only as semver allows`, () => {
    // A failure says what moved and which bump it needs; the kit's deprecated names are in _shared/extension-ui/names.mjs.
    const live = liveSurface();
    expect(linkedNameProblems(grain(`uiKitExports`), extensionApiVersion, live.uiKitExports ?? [], extensionUiDeprecated)).toEqual([]);
    expect(linkedNameProblems(grain(`moduleExports`), extensionApiVersion, live.moduleExports ?? [], apiDeprecated)).toEqual([]);
});

describe(`the linked-name rule`, () => {
    const deprecatedB = [{ name: `B`, removableIn: `3.0.0` }];

    test(`a name that leaves undeclared fails, bumped or not`, () => {
        expect(linkedNameProblems({ "2.31.0": [`A`, `B`] }, `2.31.0`, [`A`], [])).toEqual([
            `B left, and every extension importing it would stop loading: put it back, or declare it deprecated and drop it in a major`,
        ]);
        expect(linkedNameProblems({ "2.31.0": [`A`, `B`], "3.0.0": [`A`] }, `3.0.0`, [`A`], [])).toEqual([
            `3.0.0 drops B, which was never declared deprecated`,
        ]);
    });

    test(`a deprecated name may leave in a major at or past its floor`, () => {
        expect(linkedNameProblems({ "2.31.0": [`A`, `B`], "3.0.0": [`A`] }, `3.0.0`, [`A`], deprecatedB)).toEqual([]);
    });

    test(`a deprecated name still needs the major, and its floor`, () => {
        expect(linkedNameProblems({ "2.31.0": [`A`, `B`] }, `2.31.0`, [`A`], deprecatedB)).toEqual([
            `B left: dropping a deprecated name moves extensionApiVersion a major, at 3.0.0 or later, recorded in surface.json`,
        ]);
        expect(linkedNameProblems({ "2.31.0": [`A`, `B`], "2.32.0": [`A`] }, `2.32.0`, [`A`], deprecatedB)).toEqual([
            `2.32.0 drops B outside a major`,
        ]);
        expect(linkedNameProblems({ "2.31.0": [`A`, `B`], "3.0.0": [`A`] }, `3.0.0`, [`A`], [{ name: `B`, removableIn: `4.0.0` }])).toEqual([
            `3.0.0 drops B before 4.0.0, the floor its deprecation set`,
        ]);
    });

    test(`an addition needs a new minor recorded`, () => {
        expect(linkedNameProblems({ "2.31.0": [`A`] }, `2.31.0`, [`A`, `C`], [])).toEqual([
            `C joined without a version: an addition moves extensionApiVersion a minor, recorded in surface.json`,
        ]);
        expect(linkedNameProblems({ "2.31.0": [`A`], "2.31.1": [`A`, `C`] }, `2.31.1`, [`A`, `C`], [])).toEqual([
            `2.31.1 adds C in a patch over 2.31.0: an addition is a minor`,
        ]);
        expect(linkedNameProblems({ "2.31.0": [`A`], "2.32.0": [`A`, `C`] }, `2.32.0`, [`A`, `C`], [])).toEqual([]);
    });

    test(`versions recorded before the grain are not steps`, () => {
        expect(linkedNameProblems({ "2.30.0": undefined, "2.31.0": [`A`] }, `2.31.0`, [`A`], [])).toEqual([]);
    });

    test(`a deprecation must name something the kit has had`, () => {
        expect(linkedNameProblems({ "2.31.0": [`A`] }, `2.31.0`, [`A`], [{ name: `Typo`, removableIn: `3.0.0` }])).toEqual([
            `Typo is declared deprecated, and no recorded version has it`,
        ]);
    });
});

test(`the SDK README names exactly the contribution points the schema has`, () => {
    // The README's list is what an author reads before the schema; it must not silently go stale.
    const readme = readFileSync(resolve(sdkRoot, `README.md`), `utf8`);
    const sentence = /Contribution points:([\s\S]*?), plus the/.exec(readme);
    expect(sentence).not.toBeNull();
    const named = [...(sentence?.[1] ?? ``).matchAll(/`(\w+)`/g)].map((match) => match[1] ?? ``).toSorted();
    expect<readonly string[]>(named).toEqual(liveSurface().contributes);
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
