// The ready-made sources a watch can check instead of a guard command (AutomationSchema `source`), and the watch kinds
// extensions declare for them. Split from automations.ts, which re-exports all of it: that module is what an extension
// may import (extension-api's EXTENSION_WIRE).
import { z } from "zod";
import { WATCH_KIND_ID, WatchKindDeclarationSchema, watchSentence } from "@intentic/extension-manifest";

// A watch is an automation whose check decides, without a model, whether anything happened: either its `guard` command
// or a ready-made source, checked with no shell and no model (automations/watch/). Only once the check says so does
// anything run, and what it saw goes with the wake.
// url: the daemon's own kind, one page, its text or the first `select` match, for `fireOn: change`.
// (2026-11-26) Every other kind is a WATCH KIND an extension declares (`contributes.watchKinds`) and its backend checks
// (`api.checks.serve`): its id in `kind` and its parameters flat beside it, as the kind's fields name them, checked
// against that declaration when it is saved. `npm` and `github-release` were the daemon's own until then and keep the
// stored shape they always had, so nothing stored converts: the connectors extension declares and checks both now. A
// kind no enabled extension declares fails its check as an error on the run, saying so, until one does.
export const UrlWatchSourceSchema = z.object({
    kind: z.literal("url").describe("One web page."),
    url: z.string().url().describe("The page, http or https."),
    select: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe("A regular expression; what it matches (its first group, if it has one) is what is watched rather than the whole page's text."),
});
export type UrlWatchSource = z.infer<typeof UrlWatchSourceSchema>;
// The two kinds the daemon checked itself until 2026-11-26, in the exact shape a released copy speaks: an older runner or
// daemon reads and writes these on the runner door, which lags in the field, so they stay arms of their own beside the
// open one until that door's floor (_tools/checks/lib/peer-floors.mjs) passes the release that made them contributed.
// The connectors extension declares and checks both; the open arm never takes their ids, so a source matches one arm.
const RELEASED_KINDS: ReadonlySet<string> = new Set(["npm", "github-release"]);
export const NpmWatchSourceSchema = z.object({
    kind: z.literal("npm").describe("A package on the npm registry."),
    package: z.string().min(1).max(214).describe("The package name, scoped or not, like bun or @scope/name."),
    range: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("A semver range, like >=1.4.3. Passes once a published version satisfies it. Prereleases count only when the range names one."),
    tag: z.string().min(1).max(100).optional().describe("Which dist-tag to read without a range. Absent means latest."),
});
export const GithubReleaseWatchSourceSchema = z.object({
    kind: z.literal("github-release").describe("The newest release of a public GitHub repository."),
    repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, "repo must look like owner/name")
        .describe("The repository, as owner/name."),
    prereleases: z.boolean().optional().describe("Count prereleases too. Absent means only full releases."),
});
export const OpenWatchSourceSchema = z
    .object({
        kind: z
            .string()
            .regex(WATCH_KIND_ID)
            .refine((kind) => !RELEASED_KINDS.has(kind), "npm and github-release keep the shape they were released with")
            .describe("A watch kind an enabled extension declares: `automations kinds` lists them, with their parameters."),
    })
    .catchall(z.union([z.string().min(1).max(2000), z.boolean()]))
    .describe("A watch kind an extension declares, its parameters beside `kind` as the kind's fields name them.");
// Exactly one arm matches any source (`oneOf` on the wire, as the released union was).
export const WatchSourceSchema = z.xor([NpmWatchSourceSchema, GithubReleaseWatchSourceSchema, UrlWatchSourceSchema, OpenWatchSourceSchema]);
export type WatchSource = z.infer<typeof WatchSourceSchema>;
// Every kind but the daemon's own `url`, each checked by the extension that declares it.
export type ContributedWatchSource = Exclude<WatchSource, UrlWatchSource>;
// The daemon's own kind, told apart from a contributed one, whose `kind` is any word but this one.
export const isUrlSource = (source: WatchSource): source is UrlWatchSource => source.kind === "url";

// One watch kind as the catalogue serves it: what its extension declares (extension-manifest's watch-kinds.ts), the
// extension that declares it, and whether that extension is on. A kind of an extension that is off stays listed, so a
// stored source naming it still reads as what it was.
export const WatchKindSchema = WatchKindDeclarationSchema.omit({ capabilities: true }).extend({
    extension: z.string().min(1).describe("The extension that declares and checks it, as publisher.name."),
    enabled: z.boolean().describe("Whether that extension is on. A source of a kind whose extension is off fails its check until it is back."),
});
export type WatchKind = z.infer<typeof WatchKindSchema>;
export { watchParamsProblem, watchSentence, WATCH_KIND_ID, type WatchKindField } from "@intentic/extension-manifest";

// What a daemon from before contributed kinds (2026-11-26) checked itself, said as the connectors extension now
// declares them: an editor reads these only when the catalogue it is served carries no `watchKinds`, so a sandbox that
// has not updated still draws and edits the watches it has.
export const BUILT_IN_WATCH_KINDS: readonly WatchKind[] = [
    {
        id: "npm",
        label: "npm package",
        icon: "box",
        logo: "npm",
        description: "A version on the npm registry: with a range, it passes once a published version satisfies it; without, it follows a dist-tag.",
        sentence: "npm {package}[@{range}][@{tag}]",
        fields: [
            { key: "package", label: "Package", required: true, placeholder: "bun", maxLength: 214 },
            { key: "range", label: "Version range", placeholder: ">=1.4.3", hint: "Passes once a published version satisfies it.", maxLength: 200 },
            { key: "tag", label: "Dist-tag", placeholder: "latest", hint: "Without a range, which tag's version to follow. Absent means latest.", maxLength: 100 },
        ],
        extension: "intentic.connectors",
        enabled: true,
    },
    {
        id: "github-release",
        label: "GitHub release",
        icon: "github",
        logo: "github",
        description: "The newest release of a GitHub repository, read through a connected GitHub card when there is one.",
        sentence: "GitHub releases of {repo}[ (prereleases too){prereleases}]",
        fields: [
            { key: "repo", label: "Repository", required: true, placeholder: "oven-sh/bun", pattern: "^[\\w.-]+/[\\w.-]+$", patternHint: "owner/name" },
            { key: "prereleases", label: "Prereleases too", type: "switch" },
        ],
        extension: "intentic.connectors",
        enabled: true,
    },
];

/** The kinds a catalogue serves, or the built-in ones of a daemon from before it served any. */
export const watchKindsOf = (catalog: { readonly watchKinds?: readonly WatchKind[] | undefined } | undefined): readonly WatchKind[] =>
    catalog?.watchKinds ?? BUILT_IN_WATCH_KINDS;

/** What a source watches, in a few words: a contributed kind by its declaration's sentence, a page by its address. */
export const watchSourceSentence = (source: WatchSource, kinds: readonly WatchKind[]): string => {
    if (isUrlSource(source)) {
        return source.select === undefined ? source.url : `${source.url} (matching ${source.select})`;
    }
    return watchSentence(
        kinds.find((kind) => kind.id === source.kind),
        source,
    );
};
