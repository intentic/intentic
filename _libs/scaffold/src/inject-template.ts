import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { isAppDir, readTemplateManifest, type AppInstanceInput, type TemplateManifest } from "./template-manifest.js";

const exec = promisify(execFile);

// Never copied out of a source clone (or a local source dir used in tests): build output, VCS, caches.
const DENY_DIRS = new Set(["node_modules", ".git", ".cache", ".turbo", "dist", "generated", "out-tsc", "deploy"]);

const copyTree = (src: string, dest: string): Promise<void> => cp(src, dest, { recursive: true, filter: (from) => !DENY_DIRS.has(basename(from)) });

// Copy each listed source dir/file into repoDir, SKIPPING any that already exist — so a shared package an earlier
// app laid down (e.g. _libs/api-contract) is not clobbered by a later app that also lists it. Missing sources are
// ignored (a shell entry the source omits simply doesn't land).
const copyItems = async (sourceDir: string, repoDir: string, items: readonly string[]): Promise<void> => {
    for (const item of items) {
        const from = join(sourceDir, item);
        const to = join(repoDir, item);
        if (existsSync(from) && !existsSync(to)) {
            await copyTree(from, to);
        }
    }
};

// Copy an app dir to a RENAMED target and rewrite its package.json name from `@scope/<templateKey>` to
// `@scope/<instanceName>`. Also stamps the template key into `intentic.template` so the daemon can later
// identify which template created this instance. Called only when the instance name differs from the template
// key — otherwise the plain copyItems path handles it (the dir keeps its canonical name).
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

    // Rewrite the package name + stamp the template marker in the destination's package.json.
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

// Lay down an EMPTY pnpm+turbo monorepo into `repoDir` from an already-materialized source tree: the shell (root
// files) + shared packages only — no app instances — then `git init` so it can later be pushed. Apps are added
// into this same repo afterwards via `injectApps`.
export const injectMonorepoShell = async (opts: { repoDir: string; sourceDir: string; manifest: TemplateManifest }): Promise<void> => {
    await mkdir(opts.repoDir, { recursive: true });
    await copyItems(opts.sourceDir, opts.repoDir, [...opts.manifest.shell, ...opts.manifest.shared]);
    await exec("git", ["init", "-q", opts.repoDir]);
};

// Stamp the template key into an already-copied (canonical-named) app's package.json, so the daemon can
// discover which template created it. Skipped if the marker is already present.
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

// Inject one or more named app instances into an EXISTING monorepo `repoDir` from a materialized source tree.
// Each entry carries a `template` key (the manifest key, e.g. "api") and a `name` (the user-chosen instance
// name, e.g. "shop-api"). App-specific dirs (`_apps/*`) are renamed to the instance name; shared dirs
// (`_libs/*`, `_tools/*`) keep their canonical names and are only injected once (skip-existing). Unknown
// template keys throw.
export const injectApps = async (opts: {
    repoDir: string;
    sourceDir: string;
    manifest: TemplateManifest;
    apps: readonly AppInstanceInput[];
}): Promise<void> => {
    for (const app of opts.apps) {
        const def = opts.manifest.templates[app.template];
        if (def === undefined) {
            throw new Error(`unknown app "${app.template}" — known: ${Object.keys(opts.manifest.templates).join(", ")}`);
        }

        for (const item of def.instance) {
            if (isAppDir(item) && app.name !== app.template) {
                // App-specific dir — copy and rename to the instance name.
                await copyAndRenameApp(opts.sourceDir, opts.repoDir, item, app.name, app.template, opts.manifest.scope);
            } else if (isAppDir(item)) {
                // App-specific dir but name matches template key — copy verbatim, then stamp the marker.
                await copyItems(opts.sourceDir, opts.repoDir, [item]);
                await stampTemplateMarker(opts.repoDir, item, app.template);
            } else {
                // Shared dir — copy verbatim (skip-existing).
                await copyItems(opts.sourceDir, opts.repoDir, [item]);
            }
        }
    }
};

// Shallow-clone the template source into a temp dir, hand it to `fn`, and always clean it up. `source` may be a
// git URL or a local checkout. ponytail: fresh shallow clone per call — no cache; add one if latency ever matters.
const withTemplateClone = async <T>(source: string, ref: string, fn: (sourceDir: string) => Promise<T> | T): Promise<T> => {
    const sourceDir = await mkdtemp(join(tmpdir(), "intentic-template-"));
    try {
        await exec("git", ["clone", "-q", "--depth", "1", "--branch", ref, source, sourceDir]);
        return await fn(sourceDir);
    } finally {
        await rm(sourceDir, { recursive: true, force: true });
    }
};

// Read the source repo's template manifest without materializing anything — the daemon lists addable app types from this.
export const fetchTemplateManifest = (source: string, ref: string): Promise<TemplateManifest> =>
    withTemplateClone(source, ref, (sourceDir) => readTemplateManifest(sourceDir));

// The end-to-end empty-monorepo scaffold: clone the source, lay down the shell + shared packages, `git init`. No
// install — an empty shell has nothing to run until the first app is added (which installs). Shared by the CLI
// and the sandbox daemon's monorepo capability so there is one path. Errors (bad ref) propagate.
export const scaffoldMonorepo = (opts: { repoDir: string; source: string; ref: string }): Promise<void> =>
    withTemplateClone(opts.source, opts.ref, (sourceDir) =>
        injectMonorepoShell({ repoDir: opts.repoDir, sourceDir, manifest: readTemplateManifest(sourceDir) }),
    );

// Run a command and yield its stdout line by line, keeping a stderr tail for the failure message. The exit
// promise is created BEFORE the stdout iteration so a fast-exiting process can't slip its close event past us.
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

// The end-to-end add: clone the source, inject the requested app instances into an existing monorepo, and (unless
// disabled) `pnpm install`. Shared by the CLI's `add-app` and the daemon's /workspace/apps route — both stream the
// yielded progress lines (steps + live pnpm output) to the user. Errors (bad ref, unknown app) propagate. The
// clone/cleanup is inlined rather than via withTemplateClone: its finally would remove the tempdir as soon as the
// generator is RETURNED, before iteration ever runs.
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
        await exec("git", ["clone", "-q", "--depth", "1", "--branch", opts.ref, opts.source, sourceDir]);
        const manifest = readTemplateManifest(sourceDir);
        for (const app of opts.apps) {
            yield app.name === app.template ? `Adding ${app.name}…` : `Adding ${app.name} (${app.template})…`;
            await injectApps({ repoDir: opts.repoDir, sourceDir, manifest, apps: [app] });
        }
        if (opts.install !== false) {
            yield "Installing dependencies — this can take a few minutes…";
            yield* runStreaming("pnpm", ["install", "--reporter=append-only"], opts.repoDir);
        }
    } finally {
        await rm(sourceDir, { recursive: true, force: true });
    }
}
