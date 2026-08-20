import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
    gitInit,
    INTENT_GITIGNORE,
    INTENT_TSCONFIG,
    intentPackageJson,
    libsLinkSpec,
    scaffoldDeployConfig,
    TARGET_GITIGNORE,
} from "@intentic/scaffold";
import { APP_DIR, CONFIG_FILE, INTENT_DIR, TARGET_DIR } from "../lib/artifact.js";
import { renderTemplate } from "../lib/templates.js";
import { scaffoldApp } from "./scaffold-app.js";

const exec = promisify(execFile);

const starterConfig = (): string => renderTemplate("scaffold/deploy.config.ts", {});

// Self-host variant: when the sandbox was wired with a local deploy target (connect.{sh,ps1}), scaffold the
// example app onto `self`, the host the daemon auto-registers in the managed `// <intentic>` block, so
// Provision works with no edits. `self` is referenced, never declared here (the daemon owns that declaration; a
// second one would duplicate it). The domain is app.<zone> for the sandbox's Cloudflare zone (falls back to the
// example placeholder when the zone is unknown). No DB env, the zero-dependency starter app needs none.
export const selfHostConfig = (zone: string | undefined): string =>
    renderTemplate("scaffold/deploy.config.selfhost.ts", { zone: zone ?? "example.com" });

// Scaffold the local workspace: an `intent` repo (holds deploy.config.ts and its package), a `desired-state`
// repo (holds the artifact `resolve` writes and the status `apply` writes), and, unless `minimal`, an `app`
// repo (the application code), each its own git repo so the generated target can later become PR-managed and
// `adopt` can push it. The intent repo is a self-contained TS project against `@intentic/{graph,sdk}`, pinned
// to the CLI's own version, or linked to local source with `--link`. `appRepo`, when set, clones an existing
// repo as the app instead of scaffolding a starter. `selfHost` scaffolds the example app onto the auto-registered
// `self` deploy target (domain app.`zone`) so Provision works with no edits; otherwise a placeholder remote host.
// `minimal` scaffolds a reachability-only ledger: an empty config (no host, no app), nothing to provision yet.
export const scaffold = async (
    dir: string,
    version: string,
    link: boolean,
    appRepo: string | undefined,
    selfHost: boolean,
    zone: string | undefined,
    minimal: boolean,
): Promise<{ readonly intentDir: string; readonly targetDir: string; readonly appDir: string | undefined }> => {
    const intentDir = join(dir, INTENT_DIR);
    const targetDir = join(dir, TARGET_DIR);
    const appDir = join(dir, APP_DIR);
    try {
        await gitInit(intentDir);
        await gitInit(targetDir);
        await writeFile(join(intentDir, CONFIG_FILE), minimal ? scaffoldDeployConfig([]) : selfHost ? selfHostConfig(zone) : starterConfig());
        await writeFile(
            join(intentDir, "package.json"),
            intentPackageJson(link ? libsLinkSpec("graph") : `~${version}`, link ? libsLinkSpec("sdk") : `~${version}`),
        );
        await writeFile(join(intentDir, "tsconfig.json"), INTENT_TSCONFIG);
        await writeFile(join(intentDir, ".gitignore"), INTENT_GITIGNORE);
        await writeFile(join(targetDir, ".gitignore"), TARGET_GITIGNORE);
        // A minimal ledger is reachability-only: no app repo (it arrives with the "Deploy on this machine" flow).
        // Otherwise scaffold the app BEFORE `pnpm install`: a failed install must not also cost us /work/app (the
        // dev server's cwd, its absence surfaces as a confusing `spawn pnpm ENOENT`). The install goes last, as
        // the one step that reaches the network and is most likely to fail.
        if (!minimal) {
            await scaffoldApp(appDir, appRepo);
        }
        await exec("pnpm", ["install", "--ignore-workspace"], { cwd: intentDir });
    } catch (error) {
        // All-or-nothing: a partial scaffold leaves /work/intent in place, and the daemon gates init on its
        // existence (sandbox main.ts), so a half-built workspace would freeze the failure across every restart.
        // Remove what we created so the next boot re-inits from a clean slate (CLAUDE.md: assume fresh state).
        await rm(intentDir, { recursive: true, force: true });
        await rm(targetDir, { recursive: true, force: true });
        await rm(appDir, { recursive: true, force: true });
        throw error;
    }
    return { intentDir, targetDir, appDir: minimal ? undefined : appDir };
};
