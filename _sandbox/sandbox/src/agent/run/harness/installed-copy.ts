import { access, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isMissing } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { extensionIdOf, type ExtensionManifest } from "@intentic/extension-manifest";
import type { Capability } from "@intentic/sandbox-contract";
import { extensionDir, extensionRootOf, extensionsRoot, readExtensionManifest } from "../../../capabilities/extension-dirs.js";
import { statusPaths } from "../../../git/changes/changes.js";
import { parseRemote, remoteUrlsOf } from "../../../git/remote/remote-urls.js";
import { discoverRepos } from "../../../workspace/layout/repo-discovery.js";

// The note an edit gets when it lands in a copy of an extension the sandbox RUNS rather than one it builds: the git
// checkout an install keeps at .intentic/local/extensions/<capability id>, or an extension baked into the image. Both
// look like source (a manifest, src/, a build script) and are the fastest way to see a change, which is why agents
// edit them; neither is reviewed or landed, and an update replaces both. Said once per copy per turn, naming where the
// source is and how to see it running (`extension dev`), so the next edit goes there instead.

const INSTALLED = /(?:^|\/)\.intentic\/local\/extensions\/([^/]+)\//;
// An update's staging clone and the version it keeps one step back are copies of the same install.
const SIDE_COPY = /^\.(.+)\.(?:cloning|previous)$/;

export type CopyHit = { readonly kind: "installed"; readonly dir: string } | { readonly kind: "baked"; readonly name: string };

// Which running copy a written path is in, by the path alone: relative or absolute, in a worktree or the main tree.
export const installedCopyOf = (file: string, bakedRoot: string | undefined): CopyHit | undefined => {
    const path = file.replaceAll("\\", "/");
    const installed = INSTALLED.exec(path);
    if (installed !== null) {
        const dir = installed[1] as string;
        return { kind: "installed", dir: SIDE_COPY.exec(dir)?.[1] ?? dir };
    }
    const baked = bakedRoot === undefined || bakedRoot === "" ? undefined : `${bakedRoot.replace(/\/+$/, "")}/`;
    if (baked !== undefined && isAbsolute(path) && path.startsWith(baked)) {
        const name = path.slice(baked.length).split("/")[0];
        return name === undefined || name === "" ? undefined : { kind: "baked", name };
    }
    return undefined;
};

// What the note says about the copy; every field but the id is best-effort.
export interface CopyFacts {
    // The manifest id, e.g. intentic.maintenance; the directory name when the manifest can't be read.
    readonly id: string;
    // What `extension dev` takes: the manifest's own name, e.g. maintenance.
    readonly short: string;
    readonly url?: string | undefined;
    readonly ref?: string | undefined;
    // Workspace-relative directory holding the extension's source, when this workspace has one.
    readonly source?: string | undefined;
}

const code = (text: string): string => `\`${text}\``;
const capitalized = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export const installedCopyNote = (display: string, how: string, hit: CopyHit, facts: CopyFacts, bakedRoot?: string): string => {
    if (hit.kind === "baked") {
        const where = `${(bakedRoot ?? "").replace(/\/+$/, "")}/${hit.name}`;
        return [
            `${capitalized(how)} changed ${code(display)}, which is in ${facts.id} as baked into the sandbox image (${code(where)}). ` +
                `A change here is never reviewed or landed, and the next image update replaces it.`,
            facts.source === undefined
                ? `Change its source instead: ${code(`_extensions/${hit.name}`)} in the intentic repository, which this workspace has no checkout of. ` +
                  `Put back what you changed here, and tell the owner the change belongs in the product.`
                : `Change its source instead, ${code(facts.source)}; it reaches this sandbox with the next sandbox release. Put back what you changed here.`,
        ].join("\n");
    }
    const install = `.intentic/local/extensions/${hit.dir}`;
    const origin =
        facts.url === undefined ? "" : `, the sandbox's clone of ${facts.url}${facts.ref === undefined ? "" : ` at ${facts.ref.slice(0, 7)}`}`;
    const source =
        facts.source === undefined
            ? `No checkout of it is in this workspace, and a clone you make inside this conversation does not land with your work, ` +
              `so ask the owner to add one under ${code(`extensions/${facts.short}`)} before changing it.`
            : `Change its source instead: ${code(facts.source)}. Build it there (its ${code("dist/")} bundle is committed with the source), then run ` +
              `${code(`extension dev ${facts.short}`)} so the sandbox runs your checkout and the owner sees it on reload; ` +
              `${code(`extension dev ${facts.short} --off`)} goes back to the installed version.`;
    return [
        `${capitalized(how)} changed ${code(display)}, which is in the installed copy of ${facts.id} (${code(install)}${origin}). ` +
            `Every conversation runs this copy live: nothing in it is reviewed or landed, and the extension's next update replaces it.`,
        source,
        `Put back what you changed here with ${code(`git -C ${install} checkout -- <files>`)} (a rebuilt ${code("dist/")} counts as changed), ` +
            `unless the owner asked for a stopgap in the installed copy; if they did, say so in your reply.`,
    ].join("\n");
};

export interface InstalledCopyDeps {
    // The workspace root as the daemon sees it, where installs live and source checkouts are looked for.
    readonly root: string;
    readonly bakedRoot: () => string | undefined;
    readonly capabilities: () => Promise<readonly Capability[]>;
    // The name the model is told, relative to the tree; undefined for a file outside it.
    readonly relative: (file: string) => string | undefined;
    readonly git?: GitRunner;
}

const exists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

const sameProject = (left: string, right: string): boolean => {
    const a = parseRemote(left);
    const b = parseRemote(right);
    return a !== undefined && b !== undefined && a.host === b.host && a.project.toLowerCase() === b.project.toLowerCase();
};

// The workspace repo whose remote is the install's own, `extensions/` first since that is where they are kept.
const checkoutOf = async (root: string, url: string, git: GitRunner): Promise<string | undefined> => {
    const repos = (await discoverRepos(root)).toSorted((a, b) => Number(!a.startsWith("extensions/")) - Number(!b.startsWith("extensions/")));
    for (const repo of repos) {
        if ((await remoteUrlsOf(join(root, repo), git)).some((remote) => sameProject(remote, url))) {
            return repo;
        }
    }
    return undefined;
};

const named = (manifest: ExtensionManifest | undefined, fallback: string): Pick<CopyFacts, "id" | "short"> =>
    manifest === undefined ? { id: fallback, short: fallback.replace(/^intentic-/, "") } : { id: extensionIdOf(manifest), short: manifest.name };

const factsOf = async (deps: InstalledCopyDeps, hit: CopyHit, git: GitRunner): Promise<CopyFacts> => {
    if (hit.kind === "baked") {
        // allow(silent-catch): a copy whose manifest cannot be read is named by its folder (named), and the note still goes out
        const manifest = await readExtensionManifest(join(deps.bakedRoot() ?? "", hit.name)).catch(() => undefined);
        const repos = await discoverRepos(deps.root);
        let source: string | undefined;
        for (const repo of ["", ...repos]) {
            const candidate = join(repo, "_extensions", hit.name);
            if (await exists(join(deps.root, candidate, "intentic-extension.json"))) {
                source = candidate;
                break;
            }
        }
        return { ...named(manifest, hit.name), source };
    }
    const capability = (await deps.capabilities()).find((each) => each.kind === "extension" && each.id === hit.dir);
    const config = capability?.kind === "extension" ? capability.config : undefined;
    // allow(silent-catch): a copy whose manifest cannot be read is named by its folder (named), and the note still goes out
    const manifest = await readExtensionManifest(extensionRootOf(extensionDir(deps.root, hit.dir), config?.path)).catch(() => undefined);
    // allow(silent-catch): a source no repo here can be asked about is a source this workspace has no checkout of, which the note says
    const source = config === undefined ? undefined : await checkoutOf(deps.root, config.url, git).catch(() => undefined);
    return {
        ...named(manifest, hit.dir),
        url: config?.url,
        ref: config?.ref,
        source: source === undefined ? undefined : extensionRootOf(source, config?.path),
    };
};

// Same signature as every edit reviewer: undefined means nothing to say. Once per copy per turn: the model keeps the
// first note in context, and repeating it on every save would bury the edits' own diagnostics.
export const installedCopyReviewer = (deps: InstalledCopyDeps) => {
    const said = new Set<string>();
    const git = deps.git ?? defaultGit;
    return async (file: string, how: string): Promise<string | undefined> => {
        const bakedRoot = deps.bakedRoot();
        const hit = installedCopyOf(file, bakedRoot);
        if (hit === undefined) {
            return undefined;
        }
        const key = hit.kind === "installed" ? `installed:${hit.dir}` : `baked:${hit.name}`;
        if (said.has(key)) {
            return undefined;
        }
        said.add(key);
        const fallback = hit.kind === "installed" ? hit.dir : hit.name;
        const facts = await factsOf(deps, hit, git).catch((): CopyFacts => ({ id: fallback, short: fallback.replace(/^intentic-/, "") }));
        return installedCopyNote(deps.relative(file) ?? file, how, hit, facts, bakedRoot);
    };
};

// A runner of its own so the status read is never served from the checkout feed's cache: a rebuilt dist/ is under an
// ignored directory name, so nothing would have told the cache it changed.
const uncachedGit: GitRunner = (dir, args, env) => defaultGit(dir, args, env);

// Every dirty file in the installs' checkouts, workspace-relative (.intentic/local/extensions/<id>/<path>), for the
// shell edit tracker: a build or a `sed -i` inside an install shows up as a change the command made, so the note above
// answers it too. Installs are git clones, so their own status is the honest reading.
export const installedCopyDirtyPaths =
    (root: string, git: GitRunner = uncachedGit) =>
    async (): Promise<string[]> => {
        const base = extensionsRoot(root);
        // No installs folder is no install; any other refusal reaches the caller.
        const dirs = await readdir(base, { withFileTypes: true }).catch((error: unknown) => {
            if (isMissing(error)) {
                return [];
            }
            throw error;
        });
        const listed = await Promise.all(
            dirs
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
                .map(async (entry) =>
                    (await statusPaths(join(base, entry.name), git).catch((): string[] => [])).map(
                        (path) => `.intentic/local/extensions/${entry.name}/${path}`,
                    ),
                ),
        );
        return listed.flat();
    };
