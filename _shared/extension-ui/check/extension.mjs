// WHAT AN EXTENSION MUST CHANGE FOR THE KIT IT BUILDS AGAINST, judged where the extension is built. The kit's decisions
// and deprecations were enforced only on the templates inside the intentic repository, so an extension shipped from its
// own repository kept a retired look (a skeleton wired by hand, a caption beside a header, an icon nudged by a pixel) or
// imported a name its `engines.intentic` floor did not promise, with nothing saying so until a host refused it. This
// reads an extension's sources against the same records the host is held to:
// - a deprecated kit name imported (names.mjs `extensionUiDeprecated`), with what replaced it;
// - a retired prop passed or recipe member called (names.mjs `extensionUiRetired`), with why;
// - the kit's decided looks (kit-decisions.mjs: a header decision at the call site, a header drawn by hand, a card in a
//   card, sections nothing spaces, a row's own height, an icon nudged by hand);
// - a name imported from the kit or the API that the manifest's `engines.intentic` floor does not have, read off the
//   API's surface record (surface.json), so a bundle never reaches a host whose link would fail.
// Pure: the caller hands in the files, the manifest and the surface record. check/cli.mjs is the command around it.
import { extensionUiDeprecated, extensionUiNames, extensionUiRetired } from "../names.mjs";
import { glyphFindings, sectionFindings } from "./kit-decisions.mjs";
import { blank } from "./scan.mjs";

const KIT = `@intentic/extension-ui`;
const API = `@intentic/extension-api`;

// A finding at a line excused by `allow(kit-check): <reason>` on that line or the one above it, in any comment form.
const ALLOW = /allow\(kit-check\):\s*\S/u;
const excused = (lines, line) => ALLOW.test(lines[line - 1] ?? ``) || ALLOW.test(lines[line - 2] ?? ``);

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

// The value names one `import { … } from "<pkg>[/sub]"` brings in (type-only imports and members link nothing).
const IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](@intentic\/extension-(?:ui|api))(?:\/[\w-]+)?["']/gu;
const importsOf = (text) =>
    [...text.matchAll(IMPORT)].flatMap((match) =>
        match[1] !== undefined
            ? []
            : match[2]
                  .split(`,`)
                  .map((entry) => entry.trim())
                  .filter((entry) => entry !== `` && !entry.startsWith(`type `))
                  .map((entry) => ({ name: entry.split(/\s+as\s+/u)[0].trim(), from: match[3], index: match.index })),
    );

// `^2.34.0` or `2.34.0`, the two forms the host's matcher (extension-api engines.ts) accepts; its floor, or undefined.
const floorOf = (range) => {
    const match = /^\s*\^?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/u.exec(range ?? ``);
    return match === null ? undefined : `${match[1]}.${match[2] ?? 0}.${match[3] ?? 0}`;
};
const parts = (version) => version.split(`.`).map(Number);
const compare = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

// The first recorded version each name of one grain appears in, and the version the grain was first recorded at (a name
// already there may be older than the record, so it says nothing about a floor below it).
const firstSeen = (surface, grain) => {
    const versions = Object.keys(surface)
        .filter((version) => Array.isArray(surface[version]?.[grain]))
        .toSorted(compare);
    const seen = new Map();
    for (const version of versions) {
        for (const name of surface[version][grain]) {
            if (!seen.has(name)) {
                seen.set(name, version);
            }
        }
    }
    return { seen, start: versions[0] };
};

const DEPRECATED = new Map(extensionUiDeprecated.map((entry) => [entry.name, entry]));
const KIT_NAMES = new Set(extensionUiNames);
// A recipe member called by its name (`ui.sectionLabel(`), from a template binding or a script alike.
const MEMBERS = extensionUiRetired
    .filter((entry) => entry.name.startsWith(`ui.`))
    .map((entry) => ({ ...entry, pattern: new RegExp(`\\b${entry.name.replace(`.`, `\\.`)}(?:Sm)?\\b`, `gu`) }));

const MANIFEST = `intentic-extension.json`;

// One file's findings at a source offset, unless the line (or the one above it) excuses them.
const sourceFindings = ({ path, text }, found) => {
    const lines = text.split(`\n`);
    return found
        .map(({ index, why }) => ({ line: lineOf(text, index), why }))
        .filter(({ line }) => !excused(lines, line))
        .map(({ line, why }) => ({ at: `${path}:${line}`, why }));
};

// A deprecated kit name, or one the kit does not have, imported.
const importFindings = (file) =>
    sourceFindings(
        file,
        importsOf(file.text)
            .filter(({ from }) => from === KIT)
            .flatMap(({ name, index }) => {
                const deprecated = DEPRECATED.get(name);
                return [
                    ...(deprecated === undefined
                        ? []
                        : [{ index, why: `\`${name}\` is deprecated since extension API ${deprecated.since}, removable in ${deprecated.removableIn}: use \`${deprecated.use}\`` }]),
                    ...(KIT_NAMES.has(name) ? [] : [{ index, why: `\`${name}\` is not a name the kit exports, so the bundle fails to link: see names.mjs in ${KIT}` }]),
                ];
            }),
    );

// A retired recipe member called, in a template binding or a script.
const memberFindings = (file) =>
    sourceFindings(
        file,
        MEMBERS.flatMap((member) =>
            [...file.text.matchAll(member.pattern)].map((match) => ({ index: match.index, why: `\`${member.name}\` is retired since extension API ${member.since}: ${member.why}` })),
        ),
    );

// The kit's decided looks, read off a template.
const templateFindings = ({ path, text }) => {
    if (!path.endsWith(`.vue`)) {
        return [];
    }
    const lines = text.split(`\n`);
    const scan = blank(text);
    return [...sectionFindings(path, scan), ...glyphFindings(path, scan)].filter(
        (finding) => !excused(lines, Number(finding.at.slice(finding.at.lastIndexOf(`:`) + 1))),
    );
};

// Whether `engines.intentic` is a range the host reads, and whether its floor has every name the sources import.
const enginesFindings = (files, range, surface) => {
    const floor = floorOf(range);
    if (range === undefined) {
        return [];
    }
    if (floor === undefined) {
        return [{ at: MANIFEST, why: `engines.intentic "${range}" is neither an exact version nor a caret range, the two the host reads: it refuses the extension` }];
    }
    const imports = files.flatMap((file) => importsOf(file.text).map((entry) => ({ ...entry, file })));
    if (surface === undefined) {
        return imports.length === 0
            ? []
            : [{ at: MANIFEST, why: `${API}'s surface record (surface.json) could not be read, so whether engines.intentic "${range}" promises every name imported is unjudged: install the extension's dependencies` }];
    }
    const newest = Object.keys(surface).toSorted(compare).at(-1);
    if (surface[floor] === undefined && compare(floor, newest) > 0) {
        return [{ at: MANIFEST, why: `engines.intentic "${range}" asks for an extension API newer than the ${API} installed here records: update ${API}` }];
    }
    const grains = { [KIT]: firstSeen(surface, `uiKitExports`), [API]: firstSeen(surface, `moduleExports`) };
    // Names the floor's host lacks, each with where it is imported and the version that brought it. A name already there
    // when its grain was first recorded may be older than the record, so it says nothing about a floor below it.
    const needs = imports
        .map(({ name, from, index, file }) => ({ name, at: `${file.path}:${lineOf(file.text, index)}`, since: grains[from].seen.get(name), start: grains[from].start }))
        .filter(({ since, start }) => since !== undefined && since !== start && compare(since, floor) > 0);
    const highest = needs.map(({ since }) => since).toSorted(compare).at(-1);
    if (highest === undefined) {
        return [];
    }
    const lacked = needs.map(({ name, at, since }) => `\`${name}\` (${at}, from ${since})`).join(`, `);
    return [{ at: MANIFEST, why: `engines.intentic "${range}" admits hosts from ${floor}, which lack ${lacked}: such a host refuses the bundle at link, so raise it to "^${highest}"` }];
};

/**
 * Every place an extension's sources leave the kit's decisions or its engines floor, as `{ at: "path:line", why }`.
 * `files` are `{ path, text }` (.vue and .ts/.mts/.js/.mjs; tests and declarations are the caller's to leave out),
 * `manifest` the parsed intentic-extension.json, `surface` the parsed surface.json of the extension API it builds
 * against, or undefined when that cannot be read (the engines rule then says so instead of judging).
 */
export const extensionFindings = ({ files, manifest, surface }) =>
    [
        ...enginesFindings(files, manifest?.engines?.intentic, surface),
        ...files.flatMap((file) => [...importFindings(file), ...memberFindings(file), ...templateFindings(file)]),
    ].toSorted((a, b) => a.at.localeCompare(b.at, undefined, { numeric: true }));
