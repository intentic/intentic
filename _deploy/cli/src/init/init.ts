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

// Scaffolds onto `self`, the host the daemon auto-registers; referenced here, never declared (the daemon owns that).
// Domain is `app.<zone>` (falls back to a placeholder if the zone is unknown).
export const selfHostConfig = (zone: string | undefined): string =>
    renderTemplate("scaffold/deploy.config.selfhost.ts", { zone: zone ?? "example.com" });

// Scaffolds separate git repos (intent, desired-state, and unless `minimal` an app), each independently PR-manageable
// and adoptable. `selfHost` targets the daemon's auto-registered `self` host; otherwise a placeholder remote.
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
        // Scaffolds the app before `pnpm install`, so a failed install doesn't also cost /work/app; install runs last.
        if (!minimal) {
            await scaffoldApp(appDir, appRepo);
        }
        await exec("pnpm", ["install", "--ignore-workspace"], { cwd: intentDir });
    } catch (error) {
        // All-or-nothing: a partial scaffold would freeze init's daemon gate; removes everything created.
        await rm(intentDir, { recursive: true, force: true });
        await rm(targetDir, { recursive: true, force: true });
        await rm(appDir, { recursive: true, force: true });
        throw error;
    }
    return { intentDir, targetDir, appDir: minimal ? undefined : appDir };
};
