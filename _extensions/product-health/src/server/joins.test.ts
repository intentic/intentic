import { frameFile, frameLink, framePath, pinLine, pinsIn, releaseLink, sdkPins, type Workspace } from "./joins.js";

// A workspace in memory: repositories, their tracked files and contents, and the commits each holds.
const workspaceOf = (repos: Record<string, Record<string, string>>, commits: Record<string, readonly string[]> = {}): Workspace => ({
    repos: async () => Object.keys(repos),
    dirOf: (repo) => `/w/${repo}`,
    git: async (dir, args) => {
        const repo = dir.slice(`/w/`.length);
        const files = Object.keys(repos[repo] ?? {});
        if (args[0] === `ls-files`) {
            const specs = args.slice(args.indexOf(`--`) + 1).map((spec) => spec.replace(`:(glob)**/`, ``));
            const matches = (path: string, spec: string): boolean => {
                const name = path.split(`/`).at(-1) ?? path;
                const pattern = new RegExp(`^${spec.replaceAll(`.`, `\\.`).replaceAll(`*`, `.*`)}$`);
                return pattern.test(name);
            };
            return files.filter((path) => specs.some((spec) => matches(path, spec))).join(`\0`);
        }
        if (args[0] === `cat-file`) {
            const commit = (args[2] ?? ``).replace(`^{commit}`, ``);
            if ((commits[repo] ?? []).includes(commit)) {
                return ``;
            }
            throw new Error(`fatal: Not a valid object name`);
        }
        throw new Error(`unexpected git ${args.join(` `)}`);
    },
    read: async (path) => {
        const [repo, ...rest] = path.slice(`/w/`.length).split(`/`);
        const text = repos[repo ?? ``]?.[rest.join(`/`)];
        if (text === undefined) {
            throw new Error(`ENOENT`);
        }
        return text;
    },
});

describe(`SDK pins`, () => {
    test(`a pin names the package as a whole word and carries a version; a reference to a catalog does not`, () => {
        expect(pinLine(`  posthog-js: 1.436.1`, `posthog-js`)).toBe(true);
        expect(pinLine(`        "posthog-js": "^1.436.1",`, `posthog-js`)).toBe(true);
        expect(pinLine(`posthog==3.1.0`, `posthog`)).toBe(true);
        expect(pinLine(`        "posthog-js": "catalog:",`, `posthog-js`)).toBe(false);
        expect(pinLine(`        "posthog-js-lite": "4.0.0",`, `posthog-js`)).toBe(false);
        expect(pinLine(`posthog-js==2`, `posthog`)).toBe(false);
    });

    test(`the exact version PostHog reports comes first`, () => {
        expect(pinsIn([`a: 1`, `  - posthog-js@1.436.1`, `  posthog-js: 1.436.1`, `  posthog-js: 1.400.0`].join(`\n`), [`posthog-js`], `1.436.1`)).toEqual([
            { line: 2, exact: true },
            { line: 3, exact: true },
            { line: 4, exact: false },
        ]);
    });

    test(`finds the catalog line pinning the web SDK across repositories, not the package.json that defers to it`, async () => {
        const workspace = workspaceOf({
            intentic: {
                "pnpm-workspace.yaml": [`catalog:`, `  posthog-js: 1.436.1`, `  vue: 3.5.0`].join(`\n`),
                "_editor/web/package.json": `{ "dependencies": { "posthog-js": "catalog:" } }`,
            },
            "extensions/issues": { "package.json": `{ "dependencies": { "vue": "3.5.0" } }` },
        });
        expect(await sdkPins(workspace, `web`, `1.436.1`)).toEqual([{ repo: `intentic`, path: `pnpm-workspace.yaml`, line: 2, why: `sdk-pin` }]);
    });

    test(`an SDK nobody pins in the workspace points nowhere`, async () => {
        expect(await sdkPins(workspaceOf({ app: { "package.json": `{}` } }), `python`, `3.0.0`)).toEqual([]);
    });
});

describe(`stack frames`, () => {
    test(`bundler and runtime prefixes come off; a built asset served from a URL names no source`, () => {
        expect(framePath(`webpack:///./src/app/load.ts`)).toBe(`src/app/load.ts`);
        expect(framePath(`app:///src/app/load.js?v=3`)).toBe(`src/app/load.js`);
        expect(framePath(`/srv/app/models.py`)).toBe(`srv/app/models.py`);
        expect(framePath(`https://app.example.com/assets/index-3f2a.js`)).toBeUndefined();
        expect(framePath(`<anonymous>`)).toBeUndefined();
    });

    test(`the longest unique tail wins; a tail two files share names neither`, () => {
        const files = [
            { repo: `web`, path: `src/app/load.ts` },
            { repo: `web`, path: `src/admin/load.ts` },
        ];
        expect(frameFile(`build/src/app/load.ts`, files)).toEqual({ repo: `web`, path: `src/app/load.ts` });
        expect(frameFile(`load.ts`, files)).toBeUndefined();
    });

    test(`a frame resolves to the tracked file in whichever repository holds it`, async () => {
        const workspace = workspaceOf({ web: { "src/app/load.ts": `` }, api: { "src/server.ts": `` } });
        expect(await frameLink(workspace, `webpack:///./src/app/load.ts`, 42)).toEqual({ repo: `web`, path: `src/app/load.ts`, line: 42, why: `stack-frame` });
    });
});

describe(`releases`, () => {
    test(`the repository holding the release's commit, else the one its name says`, async () => {
        const workspace = workspaceOf({ web: {}, "apps/api": {} }, { web: [`abc1234`] });
        expect(await releaseLink(workspace, `abc1234`, undefined)).toEqual({ repo: `web`, path: `.`, why: `release` });
        expect(await releaseLink(workspace, `fffffff`, `acme/api`)).toEqual({ repo: `apps/api`, path: `.`, why: `release` });
        expect(await releaseLink(workspace, `not a sha`, undefined)).toBeUndefined();
    });
});
