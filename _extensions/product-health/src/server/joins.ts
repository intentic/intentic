import { join } from "node:path";
import type { CodeLink } from "../wire.js";

/* WHERE A FINDING POINTS IN THE WORKSPACE, worked out from what PostHog measured rather than guessed by a model: the
   manifest lines pinning the SDK a health check says is outdated, the tracked file an error's top application frame
   names, and the repository holding the commit an error's release was built from. Each answer is evidence an agent
   starts from, so a link that is not certain is left out: a frame path matching many files names none of them. */

// The most links one finding carries; past this the agent searches better than a list does.
const LINKS_MAX = 3;
// The most manifests read for one SDK; a workspace with more is searched by the agent instead.
const MANIFESTS_MAX = 400;

export interface Workspace {
    // Every repository's id, relative to the workspace root (`root` is the workspace itself).
    readonly repos: () => Promise<readonly string[]>;
    // The absolute directory of a repository id.
    readonly dirOf: (repo: string) => string;
    // `git <args>` in a directory, its standard output; rejects when git exits non-zero.
    readonly git: (dir: string, args: readonly string[]) => Promise<string>;
    readonly read: (path: string) => Promise<string>;
}

// The package names each PostHog SDK ships under, by the `sdk_name` its health check reports.
const SDK_PACKAGES: ReadonlyMap<string, readonly string[]> = new Map([
    [`web`, [`posthog-js`]],
    [`node`, [`posthog-node`]],
    [`python`, [`posthog`]],
    [`react-native`, [`posthog-react-native`]],
    [`ios`, [`posthog-ios`]],
    [`android`, [`posthog-android`]],
    [`flutter`, [`posthog_flutter`]],
    [`go`, [`posthog-go`]],
    [`ruby`, [`posthog-ruby`]],
    [`php`, [`posthog-php`]],
    [`java`, [`posthog-java`, `posthog-server`]],
    [`dotnet`, [`PostHog`]],
    [`elixir`, [`posthog`]],
    [`rust`, [`posthog-rs`]],
]);

const sdkPackages = (sdk: string): readonly string[] => SDK_PACKAGES.get(sdk) ?? [`posthog-${sdk}`, `posthog_${sdk}`];

// The files a dependency is pinned in, by every ecosystem PostHog ships an SDK for.
const MANIFEST_PATHSPECS = [
    `:(glob)**/package.json`,
    `:(glob)**/pnpm-workspace.yaml`,
    `:(glob)**/requirements*.txt`,
    `:(glob)**/pyproject.toml`,
    `:(glob)**/Pipfile`,
    `:(glob)**/setup.py`,
    `:(glob)**/Gemfile`,
    `:(glob)**/go.mod`,
    `:(glob)**/Podfile`,
    `:(glob)**/Package.swift`,
    `:(glob)**/build.gradle`,
    `:(glob)**/build.gradle.kts`,
    `:(glob)**/pubspec.yaml`,
    `:(glob)**/composer.json`,
    `:(glob)**/*.csproj`,
    `:(glob)**/mix.exs`,
    `:(glob)**/Cargo.toml`,
];

const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, `\\$&`);

// A line that names the package as a whole word and carries a version: `"posthog-js": "1.436.1"`, `posthog-js: 1.436.1`,
// `posthog==3.1.0`, `gem 'posthog-ruby', '~> 2'`. A reference with no digits (`"posthog-js": "catalog:"`) points at the pin
// elsewhere, so it is not one.
export const pinLine = (line: string, name: string): boolean => new RegExp(`(^|[^A-Za-z0-9_-])${escaped(name)}([^A-Za-z0-9_-]|$)`).test(line) && /\d/.test(line);

export interface PinMatch {
    readonly line: number;
    readonly exact: boolean;
}

// Every pin of the package in one manifest's text, and whether it pins the version PostHog says is in use.
export const pinsIn = (text: string, names: readonly string[], version: string | undefined): PinMatch[] =>
    text.split(`\n`).flatMap((line, index) =>
        names.some((name) => pinLine(line, name)) ? [{ line: index + 1, exact: version !== undefined && line.includes(version) }] : [],
    );

const tracked = async (workspace: Workspace, repo: string, pathspecs: readonly string[]): Promise<string[]> => {
    try {
        const listed = await workspace.git(workspace.dirOf(repo), [`ls-files`, `-z`, `--`, ...pathspecs]);
        return listed.split(`\0`).filter((path) => path !== ``);
    } catch {
        // allow(silent-catch): not a git checkout (yet), or git refused: nothing to search there, and the other
        // repositories still answer.
        return [];
    }
};

/** The manifest lines pinning an outdated SDK; the ones pinning the exact version PostHog reports come first. */
export const sdkPins = async (workspace: Workspace, sdk: string, version: string | undefined): Promise<CodeLink[]> => {
    const names = sdkPackages(sdk);
    const found: (CodeLink & { readonly exact: boolean })[] = [];
    let read = 0;
    for (const repo of await workspace.repos()) {
        for (const path of await tracked(workspace, repo, MANIFEST_PATHSPECS)) {
            if (read >= MANIFESTS_MAX) {
                break;
            }
            read += 1;
            // allow(silent-catch): a manifest git lists but that is gone or unreadable mid-round pins nothing.
            const text = await workspace.read(join(workspace.dirOf(repo), path)).catch(() => ``);
            for (const pin of pinsIn(text, names, version)) {
                found.push({ repo, path, line: pin.line, why: `sdk-pin`, exact: pin.exact });
            }
        }
    }
    const exact = found.filter((link) => link.exact);
    return (exact.length > 0 ? exact : found).slice(0, LINKS_MAX).map(({ repo, path, line, why }) => ({ repo, path, line, why }));
};

// A frame's source as a path inside a repository: bundler and runtime prefixes taken off (`webpack:///./src/a.ts`,
// `app:///src/a.js`, `file:///…`), query and hash dropped. A built asset served from a URL (`https://…/assets/index-3f2a.js`)
// is the bundle, not the source, and answers nothing.
export const framePath = (source: string): string | undefined => {
    const trimmed = source.trim();
    if (/^https?:\/\//.test(trimmed)) {
        return undefined;
    }
    const path = trimmed
        .replace(/^[a-z][a-z0-9+.-]*:\/\/\/?/i, ``)
        .replace(/[?#].*$/, ``)
        .replace(/^(\.\/|\/)+/, ``);
    return path.includes(`/`) || path.includes(`.`) ? path : undefined;
};

// The tracked file a frame's path ends in. The longest matching tail wins; a tail several files share names none.
export const frameFile = (path: string, files: readonly { readonly repo: string; readonly path: string }[]): { readonly repo: string; readonly path: string } | undefined => {
    const segments = path.split(`/`);
    for (let take = segments.length; take >= 1; take -= 1) {
        const tail = segments.slice(-take).join(`/`);
        const matches = files.filter((file) => file.path === tail || file.path.endsWith(`/${tail}`));
        if (matches.length === 1) {
            return matches[0];
        }
        if (matches.length > 1) {
            return undefined;
        }
    }
    return undefined;
};

/** The file an error's top application frame names, in whichever repository tracks it. */
export const frameLink = async (workspace: Workspace, source: string, line: number | undefined): Promise<CodeLink | undefined> => {
    const path = framePath(source);
    if (path === undefined) {
        return undefined;
    }
    const base = path.split(`/`).at(-1) ?? path;
    const files = [];
    for (const repo of await workspace.repos()) {
        for (const file of await tracked(workspace, repo, [`:(glob)**/${base}`])) {
            files.push({ repo, path: file });
        }
    }
    const found = frameFile(path, files);
    return found === undefined ? undefined : { repo: found.repo, path: found.path, line, why: `stack-frame` };
};

/** The repository holding the commit a release was built from, or failing that the one its name says. */
export const releaseLink = async (workspace: Workspace, commit: string | undefined, repoName: string | undefined): Promise<CodeLink | undefined> => {
    const repos = await workspace.repos();
    if (commit !== undefined && /^[0-9a-f]{7,40}$/i.test(commit)) {
        for (const repo of repos) {
            const held = await workspace.git(workspace.dirOf(repo), [`cat-file`, `-e`, `${commit}^{commit}`]).then(
                () => true,
                () => false,
            );
            if (held) {
                return { repo, path: `.`, why: `release` };
            }
        }
    }
    const name = repoName?.split(`/`).at(-1)?.toLowerCase();
    const named = name === undefined ? undefined : repos.find((repo) => (repo.split(`/`).at(-1) ?? repo).toLowerCase() === name);
    return named === undefined ? undefined : { repo: named, path: `.`, why: `release` };
};
