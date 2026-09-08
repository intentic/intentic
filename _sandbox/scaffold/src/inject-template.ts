import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isAppDir, readTemplateManifest, type AppInstanceInput, type TemplateManifest } from "./template-manifest.js";

const exec = promisify(execFile);

// Never copied out of a source clone: build output, VCS, caches.
const DENY_DIRS = new Set(["node_modules", ".git", ".cache", ".turbo", "dist", "generated", "out-tsc", "deploy"]);

const copyTree = (src: string, dest: string): Promise<void> => cp(src, dest, { recursive: true, filter: (from) => !DENY_DIRS.has(basename(from)) });

// Copies each item into repoDir, skipping ones that already exist so a later app can't clobber an earlier one's shared
// package; a missing source is ignored.
const copyItems = async (sourceDir: string, repoDir: string, items: readonly string[]): Promise<void> => {
    for (const item of items) {
        const from = join(sourceDir, item);
        const to = join(repoDir, item);
        if (existsSync(from) && !existsSync(to)) {
            await copyTree(from, to);
        }
    }
};

// Copies an app dir to a renamed target, rewrites its package.json name to `@scope/<instanceName>`, and stamps
// `intentic.template`. Called only when the instance name differs from the template key.
const copyAndRenameApp = async (
    sourceDir: string,
    repoDir: string,
    item: string,
    instanceName: string,
    templateKey: string,
    scope: string,
): Promise<void> => {
    const from = join(sourceDir, item);
    if (!existsSync(from)) {
        return;
    }
    // e.g. _apps/api → _apps/<instanceName>
    const renamedItem = join(dirname(item), instanceName);
    const to = join(repoDir, renamedItem);
    if (existsSync(to)) {
        return; // another injection already landed this instance
    }
    await copyTree(from, to);

    // Rewrites the package name and stamps the template marker in the destination's package.json.
    const pkgPath = join(to, "package.json");
    if (existsSync(pkgPath)) {
        const raw = await readFile(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string; intentic?: { template?: string }; [k: string]: unknown };
        const templatePkg = basename(item); // e.g. "api"
        if (pkg.name === `${scope}${templatePkg}`) {
            pkg.name = `${scope}${instanceName}`;
        }
        pkg.intentic = { template: templateKey };
        await writeFile(pkgPath, `${JSON.stringify(pkg, undefined, 4)}\n`);
    }
};

// Lays down an empty monorepo (shell + shared packages, no apps) from a materialized source tree, then `git init`s it.
export const injectMonorepoShell = async (opts: { repoDir: string; sourceDir: string; manifest: TemplateManifest }): Promise<void> => {
    await mkdir(opts.repoDir, { recursive: true });
    await copyItems(opts.sourceDir, opts.repoDir, [...opts.manifest.shell, ...opts.manifest.shared]);
    await exec("git", ["init", "-q", opts.repoDir]);
};

// Stamps the template key into an already-copied app's package.json; a no-op if the marker is already there.
const stampTemplateMarker = async (repoDir: string, item: string, templateKey: string): Promise<void> => {
    const pkgPath = join(repoDir, item, "package.json");
    if (!existsSync(pkgPath)) {
        return;
    }
    const raw = await readFile(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { intentic?: { template?: string }; [k: string]: unknown };
    if (pkg.intentic?.template === templateKey) {
        return; // already stamped
    }
    pkg.intentic = { template: templateKey };
    await writeFile(pkgPath, `${JSON.stringify(pkg, undefined, 4)}\n`);
};

// Injects named app instances into an existing monorepo: app dirs (`_apps/*`) are renamed to the instance name, shared
// dirs (`_libs/*`, `_tools/*`) keep their name and inject once. Unknown template keys throw.
export const injectApps = async (opts: {
    repoDir: string;
    sourceDir: string;
    manifest: TemplateManifest;
    apps: readonly AppInstanceInput[];
}): Promise<void> => {
    for (const app of opts.apps) {
        const def = opts.manifest.templates[app.template];
        if (def === undefined) {
            throw new Error(`unknown app "${app.template}", known: ${Object.keys(opts.manifest.templates).join(", ")}`);
        }

        for (const item of def.instance) {
            if (isAppDir(item) && app.name !== app.template) {
                // App dir with a custom instance name.
                await copyAndRenameApp(opts.sourceDir, opts.repoDir, item, app.name, app.template, opts.manifest.scope);
            } else if (isAppDir(item)) {
                // App dir whose instance name matches the template key.
                await copyItems(opts.sourceDir, opts.repoDir, [item]);
                await stampTemplateMarker(opts.repoDir, item, app.template);
            } else {
                // Shared dir.
                await copyItems(opts.sourceDir, opts.repoDir, [item]);
            }
        }
    }
};

// GitHub's `<repo>/archive/<ref>.tar.gz` (works for branches, tags, and shas); undefined for a local or ssh/git://
// source.
export const templateArchiveUrl = (source: string, ref: string): string | undefined => {
    if (!/^https?:\/\//.test(source)) {
        return undefined;
    }
    return `${source.replace(/\/+$/, "").replace(/\.git$/, "")}/archive/${ref}.tar.gz`;
};

// Unpacks a source archive into `dir`; false means the host won't serve one (private repo, non-GitHub), so the caller
// falls back to git. Piped to tar's stdin rather than staged to disk.
const extractTemplateArchive = async (url: string, dir: string): Promise<boolean> => {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
        return false;
    }
    const archive = Buffer.from(await response.arrayBuffer());
    const tar = spawn("tar", ["-xz", "-C", dir, "--strip-components=1"], { stdio: ["pipe", "ignore", "pipe"] });
    const stderr: string[] = [];
    tar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const exit = new Promise<number>((resolve, reject) => {
        tar.on("error", reject);
        tar.on("close", (code) => resolve(code ?? 1));
    });
    tar.stdin.end(archive);
    const code = await exit;
    if (code !== 0) {
        throw new Error(`unpacking ${url} failed (tar exited with ${code})${stderr.length > 0 ? `\n${stderr.join("").trim()}` : ""}`);
    }
    return true;
};

// Archive first: an unauthenticated git clone against GitHub prompts for a username with no tty to answer, hanging
// headless runs. GIT_TERMINAL_PROMPT=0 makes the git fallback error instead; --depth 1 since only files are read.
const materializeTemplateSource = async (source: string, ref: string, dir: string): Promise<void> => {
    const archive = templateArchiveUrl(source, ref);
    if (archive !== undefined && (await extractTemplateArchive(archive, dir))) {
        return;
    }
    await exec("git", ["clone", "-q", "--depth", "1", "--branch", ref, source, dir], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
};

// Fetches the source into a temp dir, hands it to `fn`, and always removes it; a fresh fetch per call, no cache.
const withTemplateSource = async <T>(source: string, ref: string, fn: (sourceDir: string) => Promise<T> | T): Promise<T> => {
    const sourceDir = await mkdtemp(join(tmpdir(), "intentic-template-"));
    try {
        await materializeTemplateSource(source, ref, sourceDir);
        return await fn(sourceDir);
    } finally {
        await rm(sourceDir, { recursive: true, force: true });
    }
};

// Reads the source repo's template manifest without materializing anything; the daemon lists addable app types from
// this.
export const fetchTemplateManifest = (source: string, ref: string): Promise<TemplateManifest> =>
    withTemplateSource(source, ref, (sourceDir) => readTemplateManifest(sourceDir));

// Fetches the source, lays down the shell and shared packages, and `git init`s; no install, since an empty shell has
// nothing to run yet. Shared by the CLI and the daemon's monorepo capability; errors propagate.
export const scaffoldMonorepo = (opts: { repoDir: string; source: string; ref: string }): Promise<void> =>
    withTemplateSource(opts.source, opts.ref, (sourceDir) =>
        injectMonorepoShell({ repoDir: opts.repoDir, sourceDir, manifest: readTemplateManifest(sourceDir) }),
    );

// Yields stdout line by line, keeping a stderr tail for the failure message; the exit promise is created before
// iterating stdout so a fast-exiting process's close event isn't missed.
async function* runStreaming(command: string, args: string[], cwd: string): AsyncGenerator<string> {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stderrTail: string[] = [];
    createInterface({ input: child.stderr }).on("line", (line) => {
        stderrTail.push(line);
        if (stderrTail.length > 20) {
            stderrTail.shift();
        }
    });
    const exit = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
    });
    for await (const line of createInterface({ input: child.stdout })) {
        if (line.trim() !== "") {
            yield line;
        }
    }
    const code = await exit;
    if (code !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited with ${code}${stderrTail.length > 0 ? `\n${stderrTail.join("\n")}` : ""}`);
    }
}

// Fetches the source, injects the requested apps, and (unless disabled) runs pnpm install, yielding progress lines.
// Cleanup is inlined, not via withTemplateSource, whose `finally` fires on return, before this generator iterates.
export async function* addAppsToMonorepo(opts: {
    repoDir: string;
    source: string;
    ref: string;
    apps: readonly AppInstanceInput[];
    install?: boolean;
}): AsyncGenerator<string> {
    yield "Fetching the template source…";
    const sourceDir = await mkdtemp(join(tmpdir(), "intentic-template-"));
    try {
        await materializeTemplateSource(opts.source, opts.ref, sourceDir);
        const manifest = readTemplateManifest(sourceDir);
        for (const app of opts.apps) {
            yield app.name === app.template ? `Adding ${app.name}…` : `Adding ${app.name} (${app.template})…`;
            await injectApps({ repoDir: opts.repoDir, sourceDir, manifest, apps: [app] });
        }
        if (opts.install !== false) {
            yield "Installing dependencies: this can take a few minutes…";
            yield* runStreaming("pnpm", ["install", "--reporter=append-only"], opts.repoDir);
        }
    } finally {
        await rm(sourceDir, { recursive: true, force: true });
    }
}
