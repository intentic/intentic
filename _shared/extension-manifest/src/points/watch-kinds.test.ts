import { ExtensionManifestSchema } from "../manifest.js";
import { WatchKindContributionSchema, watchParamsProblem, watchSentence } from "./watch-kinds.js";

// A watch kind's declaration: what it may say, the sentence a source of it reads as, and the rule its parameters are
// held to, which the daemon, the Automations view and the approval card all read through these two functions.

const RELEASES = {
    id: "github-release",
    label: "GitHub release",
    description: "The newest release of a repository.",
    sentence: "GitHub releases of {repo}[ (prereleases too){prereleases}]",
    fields: [
        { key: "repo", label: "Repository", required: true, pattern: "^[\\w.-]+/[\\w.-]+$", patternHint: "owner/name" },
        { key: "prereleases", label: "Prereleases too", type: "switch" },
    ],
};

const manifestWith = (fields: object) => ({ publisher: "acme", name: "forge", version: "1.0.0", engines: { intentic: "^2.51.0" }, ...fields });

test("a sentence fills its parameters and drops a segment whose parameter is absent or off", () => {
    const kind = WatchKindContributionSchema.parse(RELEASES);
    expect(watchSentence(kind, { kind: "github-release", repo: "oven-sh/bun" })).toBe("GitHub releases of oven-sh/bun");
    expect(watchSentence(kind, { kind: "github-release", repo: "oven-sh/bun", prereleases: false })).toBe("GitHub releases of oven-sh/bun");
    expect(watchSentence(kind, { kind: "github-release", repo: "oven-sh/bun", prereleases: true })).toBe("GitHub releases of oven-sh/bun (prereleases too)");
    // Undeclared: the id and what it holds, so a source whose extension is gone still says what it watched.
    expect(watchSentence(undefined, { kind: "pypi", package: "httpx", pre: true, off: false })).toBe("pypi package=httpx pre");
});

test("parameters are held to the declared fields: required, pattern, type, and nothing undeclared", () => {
    const kind = WatchKindContributionSchema.parse(RELEASES);
    expect(watchParamsProblem(kind, { kind: "github-release", repo: "oven-sh/bun", prereleases: true })).toBeUndefined();
    expect(watchParamsProblem(kind, { kind: "github-release" })).toBe("Repository is required");
    expect(watchParamsProblem(kind, { kind: "github-release", repo: "bun" })).toBe("Repository must look like owner/name");
    expect(watchParamsProblem(kind, { kind: "github-release", repo: "  " })).toBe("Repository is empty");
    expect(watchParamsProblem(kind, { kind: "github-release", repo: "a/b", prereleases: "yes" })).toBe("Prereleases too is on or off");
    expect(watchParamsProblem(kind, { kind: "github-release", repo: "a/b", tag: "x" })).toBe("a github-release watch has no tag: it takes repo, prereleases");
});

test("a declaration names only its own fields, never `url` or `kind`, and a switch carries no text rules", () => {
    const issues = (declared: object): string[] => WatchKindContributionSchema.safeParse(declared).error?.issues.map((issue) => issue.message) ?? [];
    expect(issues({ ...RELEASES, id: "url" })[0]).toContain("not `url`, the sandbox's own");
    expect(issues({ ...RELEASES, sentence: "{nope}" })).toEqual(['the sentence names "{nope}", which is none of the kind\'s fields']);
    expect(issues({ ...RELEASES, fields: [...RELEASES.fields, { key: "kind", label: "Kind" }] })[0]).toContain("not `kind`");
    expect(issues({ ...RELEASES, sentence: "Watching[ (on){on}]", fields: [{ key: "on", label: "On", type: "switch", required: true }] })).toEqual(["a switch is never required and has no pattern or length"]);
    expect(issues({ ...RELEASES, sentence: "{repo}", fields: [{ key: "repo", label: "A", pattern: "(" }] })).toEqual(["the pattern does not compile as a regular expression"]);
});

test("a manifest's watch kinds need a backend to answer them, and reach only its own cards", () => {
    const parsed = (fields: object): string[] => ExtensionManifestSchema.safeParse(manifestWith(fields)).error?.issues.map((issue) => issue.message) ?? [];
    expect(parsed({ server: "dist/server.js", contributes: { watchKinds: [RELEASES] } })).toEqual([]);
    expect(parsed({ contributes: { watchKinds: [RELEASES] } })).toEqual(["watch kinds need a `server` bundle to answer their checks"]);
    expect(parsed({ server: "dist/server.js", contributes: { watchKinds: [{ ...RELEASES, capabilities: ["github"] }] } })).toEqual([
        '"github" is not one of this extension\'s own capability cards',
    ]);
    expect(parsed({ server: "dist/server.js", contributes: { watchKinds: [RELEASES, RELEASES] } })).toEqual(['the watch kind "github-release" is declared twice']);
});

test("a template takes every field the daemon's own carry, a watch's included", () => {
    const template = {
        id: "releases",
        title: "Releases",
        trigger: { kind: "schedule" as const, cron: "41 */6 * * *", tz: "Europe/Warsaw", afterSessions: 3 },
        source: { kind: "github-release", repo: "oven-sh/bun", prereleases: true },
        fireOn: "change" as const,
        until: "first-fire" as const,
        target: { kind: "extension" as const, extension: "acme.forge", handler: "sweep" },
        prompt: "Read it.",
    };
    const hook = { id: "hook", title: "Hook", trigger: { kind: "event" as const, dailyMax: 5, signature: { scheme: "github", secret: "S" } }, prompt: "Go." };
    const once = { id: "once", title: "Once", trigger: { kind: "once" as const, at: 1 }, prompt: "Go." };
    const parsed = ExtensionManifestSchema.parse(manifestWith({ contributes: { automationTemplates: [template, hook, once] } }));
    expect(parsed.contributes?.automationTemplates).toEqual([template, hook, once]);
});
