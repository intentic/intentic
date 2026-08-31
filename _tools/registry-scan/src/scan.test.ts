import { type RegistryFile, RegistryFileSchema } from "@intentic/registry";
import { describe, expect, it } from "vitest";
import type { GithubReader, GithubRepo } from "./github.js";
import { scanRegistry } from "./scan.js";

const SCANNED_AT = "2026-08-01T00:00:00.000Z";
const sha = (char: string): string => char.repeat(40);

const repo = (fullName: string, over: Partial<GithubRepo> = {}): GithubRepo => ({
    fullName,
    stars: 0,
    pushedAt: "2026-07-01T00:00:00Z",
    defaultBranch: "main",
    archived: false,
    ...over,
});

const manifest = (publisher: string, name: string, version = "1.0.0"): string =>
    JSON.stringify({ publisher, name, version, engines: { intentic: "^1.0.0" }, entry: "dist/extension.js" });

/* A reader over in-memory fixtures. `manifests` models a branch copy only for tests proving it is ignored;
 * `files` is exact content at `${fullName}@${ref}:${path}`. Proposals and existing-listing checks both read the
 * latter now, because the source commit is resolved before a single manifest byte is trusted. */
const fakeGithub = (config: {
    found?: GithubRepo[];
    repos?: Record<string, GithubRepo>;
    manifests?: Record<string, string>;
    shas?: Record<string, string>;
    files?: Record<string, string>;
}): GithubReader => ({
    searchByTopic: async () => config.found ?? [],
    getRepo: async (fullName) => config.repos?.[fullName] ?? config.found?.find((candidate) => candidate.fullName === fullName),
    headSha: async (fullName) => config.shas?.[fullName],
    readFile: async (fullName, ref, path) => {
        const exact = config.files?.[`${fullName}@${ref}:${path}`];
        if (exact !== undefined) {
            return exact;
        }
        return ref === `main` && path === `intentic-extension.json` ? config.manifests?.[fullName] : undefined;
    },
});

const file = (plugins: unknown[]): RegistryFile => RegistryFileSchema.parse({ name: "intentic", plugins });

describe(`scanRegistry`, () => {
    it(`proposes an unlisted topic-tagged repo, keyed by the manifest's publisher.name`, async () => {
        const result = await scanRegistry(
            file([]),
            fakeGithub({
                found: [repo(`acme/incidents`, { description: `Incident triage in the rail`, stars: 12 })],
                shas: { "acme/incidents": sha(`a`) },
                files: {
                    [`acme/incidents@${sha(`a`)}:intentic-extension.json`]: manifest(`acme`, `incidents`, `1.2.0`),
                    [`acme/incidents@${sha(`a`)}:dist/extension.js`]: `export const activate = () => {};`,
                },
            }),
            SCANNED_AT,
        );

        expect(result.proposals).toEqual([
            {
                repo: `acme/incidents`,
                entry: {
                    name: `acme.incidents`,
                    kind: `extension`,
                    trust: `listed`,
                    description: `Incident triage in the rail`,
                    version: `1.2.0`,
                    source: { source: `github`, repo: `acme/incidents`, sha: sha(`a`) },
                },
            },
        ]);
    });

    it(`refreshes stars for an already-listed repo instead of re-proposing it`, async () => {
        const result = await scanRegistry(
            file([{ name: `acme.incidents`, kind: `extension`, source: { source: `github`, repo: `acme/incidents`, sha: sha(`a`) } }]),
            fakeGithub({ found: [repo(`acme/incidents`, { stars: 40, pushedAt: `2026-07-29T00:00:00Z` })] }),
            SCANNED_AT,
        );

        expect(result.proposals).toEqual([]);
        expect(result.facts).toEqual({
            scannedAt: SCANNED_AT,
            entries: [
                {
                    name: `acme.incidents`,
                    stars: 40,
                    pushedAt: `2026-07-29T00:00:00Z`,
                    // The pinned commit holds no manifest in this fixture, and the fact says so instead of
                    // borrowing the branch's copy: the checks describe what an installer would get.
                    checks: { sha: sha(`a`), manifest: `no intentic-extension.json at the pinned commit`, bundle: `unchecked` },
                },
            ],
        });
    });

    // A listing that arrived by pull request has no obligation to carry the topic; its stars still count.
    it(`fetches facts for a listed repo the topic search never returned`, async () => {
        const result = await scanRegistry(
            file([{ name: `acme.quiet`, kind: `extension`, source: { source: `github`, repo: `acme/quiet`, sha: sha(`b`) } }]),
            fakeGithub({ found: [], repos: { "acme/quiet": repo(`acme/quiet`, { stars: 7 }) } }),
            SCANNED_AT,
        );

        expect(result.facts.entries).toEqual([
            {
                name: `acme.quiet`,
                stars: 7,
                pushedAt: `2026-07-01T00:00:00Z`,
                checks: { sha: sha(`b`), manifest: `no intentic-extension.json at the pinned commit`, bundle: `unchecked` },
            },
        ]);
    });

    // The anti-squat rule: identity comes from the manifest, and a copied manifest collides with the listing
    // it copied rather than quietly opening a pull request that looks legitimate.
    it(`refuses a repo claiming a publisher.name another repo already holds`, async () => {
        const result = await scanRegistry(
            file([{ name: `acme.incidents`, kind: `extension`, source: { source: `github`, repo: `acme/incidents`, sha: sha(`a`) } }]),
            fakeGithub({
                found: [repo(`typo/incidents`)],
                repos: { "acme/incidents": repo(`acme/incidents`) },
                shas: { "typo/incidents": sha(`c`) },
                files: {
                    [`typo/incidents@${sha(`c`)}:intentic-extension.json`]: manifest(`acme`, `incidents`),
                    [`typo/incidents@${sha(`c`)}:dist/extension.js`]: `export const activate = () => {};`,
                },
            }),
            SCANNED_AT,
        );

        expect(result.proposals).toEqual([]);
        expect(result.warnings).toContainEqual(expect.stringContaining(`already listed from acme/incidents`));
    });

    it(`skips a topic-tagged repo with no manifest, an unparseable one, an archive, or no commit`, async () => {
        const result = await scanRegistry(
            file([]),
            fakeGithub({
                found: [repo(`x/none`), repo(`x/broken`), repo(`x/old`, { archived: true }), repo(`x/empty`)],
                shas: { "x/none": sha(`a`), "x/broken": sha(`b`) },
                files: { [`x/broken@${sha(`b`)}:intentic-extension.json`]: JSON.stringify({ publisher: `x` }) },
            }),
            SCANNED_AT,
        );

        expect(result.proposals).toEqual([]);
        expect(result.warnings).toEqual([
            expect.stringContaining(`x/none@${sha(`a`)}: no intentic-extension.json`),
            expect.stringContaining(`x/broken@${sha(`b`)}: does not parse`),
            expect.stringContaining(`x/old: archived`),
            expect.stringContaining(`x/empty: no commit found on main`),
        ]);
    });

    it(`resolves the sha before reading a proposal and catches invalid JSON without aborting the scan`, async () => {
        const result = await scanRegistry(
            file([]),
            fakeGithub({
                found: [repo(`x/moved`), repo(`x/not-json`)],
                manifests: { "x/moved": manifest(`x`, `branch-copy`) },
                shas: { "x/moved": sha(`a`), "x/not-json": sha(`b`) },
                files: {
                    [`x/moved@${sha(`a`)}:intentic-extension.json`]: manifest(`x`, `pinned-copy`),
                    [`x/moved@${sha(`a`)}:dist/extension.js`]: `export const activate = () => {};`,
                    [`x/not-json@${sha(`b`)}:intentic-extension.json`]: `{ broken`,
                },
            }),
            SCANNED_AT,
        );

        expect(result.proposals[0]?.entry.name).toBe(`x.pinned-copy`);
        expect(result.warnings).toContainEqual(expect.stringContaining(`x/not-json@${sha(`b`)}: intentic-extension.json is not JSON`));
    });

    it(`does not propose a commit whose shipped bundle cannot load`, async () => {
        const result = await scanRegistry(
            file([]),
            fakeGithub({
                found: [repo(`x/chunked`)],
                shas: { "x/chunked": sha(`a`) },
                files: {
                    [`x/chunked@${sha(`a`)}:intentic-extension.json`]: manifest(`x`, `chunked`),
                    [`x/chunked@${sha(`a`)}:dist/extension.js`]: `import "./chunk.js";`,
                },
            }),
            SCANNED_AT,
        );

        expect(result.proposals).toEqual([]);
        expect(result.warnings[0]).toContain(`./chunk.js`);
    });

    it(`re-derives the publishability checks at the PINNED sha, not at the branch`, async () => {
        // The branch has moved on to a broken manifest; the pinned commit is fine. The checks must describe the
        // commit installs follow: reading the branch here would report a working listing as broken.
        const result = await scanRegistry(
            file([{ name: `acme.incidents`, kind: `extension`, source: { source: `github`, repo: `acme/incidents`, sha: sha(`a`) } }]),
            fakeGithub({
                found: [repo(`acme/incidents`)],
                manifests: { "acme/incidents": `{ broken` },
                files: {
                    [`acme/incidents@${sha(`a`)}:intentic-extension.json`]: manifest(`acme`, `incidents`),
                    [`acme/incidents@${sha(`a`)}:dist/extension.js`]: `import { h } from "vue";\nexport const activate = () => {};\n`,
                },
            }),
            SCANNED_AT,
        );

        expect(result.facts.entries[0]?.checks).toEqual({ sha: sha(`a`), manifest: `ok`, bundle: `ok`, engines: `^1.0.0` });
    });

    it(`reports a pinned bundle that cannot load where it is installed`, async () => {
        // The failure that is invisible to the author (their workspace loads the directory live) and fatal to
        // every installer: a second file the blob-URL import can never resolve. Re-derived cold by the shared
        // rule in @intentic/extension-manifest, so this judge and the daemon's readiness check cannot drift.
        const result = await scanRegistry(
            file([{ name: `acme.incidents`, kind: `extension`, source: { source: `github`, repo: `acme/incidents`, sha: sha(`a`) } }]),
            fakeGithub({
                found: [repo(`acme/incidents`)],
                files: {
                    [`acme/incidents@${sha(`a`)}:intentic-extension.json`]: manifest(`acme`, `incidents`),
                    [`acme/incidents@${sha(`a`)}:dist/extension.js`]: `import { helper } from "./chunk.js";\nexport const activate = () => {};\n`,
                },
            }),
            SCANNED_AT,
        );

        const checks = result.facts.entries[0]?.checks;
        expect(checks?.manifest).toBe(`ok`);
        expect(checks?.bundle).toContain(`./chunk.js`);
    });

    it(`says when the pinned manifest promises an entry file the commit does not hold`, async () => {
        const result = await scanRegistry(
            file([{ name: `acme.incidents`, kind: `extension`, source: { source: `github`, repo: `acme/incidents`, sha: sha(`a`) } }]),
            fakeGithub({
                found: [repo(`acme/incidents`)],
                files: { [`acme/incidents@${sha(`a`)}:intentic-extension.json`]: manifest(`acme`, `incidents`) },
            }),
            SCANNED_AT,
        );

        expect(result.facts.entries[0]?.checks?.bundle).toContain(`dist/extension.js`);
    });

    // Never acted on automatically: a repo that went briefly private should come back to its listing.
    it(`warns about a listing whose source repo has vanished, and drops it from the facts`, async () => {
        const result = await scanRegistry(
            file([{ name: `acme.gone`, kind: `extension`, source: { source: `github`, repo: `acme/gone`, sha: sha(`d`) } }]),
            fakeGithub({}),
            SCANNED_AT,
        );

        expect(result.facts.entries).toEqual([]);
        expect(result.warnings).toEqual([expect.stringContaining(`acme.gone: source repo acme/gone is gone`)]);
    });

    it(`ignores a listing that isn't on GitHub at all`, async () => {
        const result = await scanRegistry(
            file([{ name: `acme.self`, kind: `extension`, source: { source: `url`, url: `https://gitlab.com/acme/self.git`, sha: sha(`e`) } }]),
            fakeGithub({}),
            SCANNED_AT,
        );

        expect(result.facts.entries).toEqual([]);
        expect(result.warnings).toEqual([]);
    });
});
