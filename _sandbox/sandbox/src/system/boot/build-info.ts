import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { z } from "zod";
import { opt } from "../../opt.js";
import { buildId, version } from "../../version.js";

// WHICH BUILD IS RUNNING (2026-10-11). Every working-tree build is version 0.0.0, so "is my fix live?" took a dozen
// calls of comparing mtimes. The source commit comes from INTENTIC_COMMIT (or SOURCE_COMMIT) when the image sets it,
// else from build-info.json beside the package's package.json, which a build step writes; without either the commit is
// simply absent. builtAt falls back to the newest file under the compiled tree, the same instant buildId() names.

export interface BuildInfo {
    readonly version: string;
    readonly commit?: string;
    readonly builtAt?: string;
}

const BUILD_INFO_FILE = "build-info.json";

// Blank is absent: an unset build argument often arrives as an empty string.
const Stamp = z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1))
    .optional()
    .catch(undefined);
const StampFile = z.object({ commit: Stamp, builtAt: Stamp }).catch({});

const stamped = (): z.infer<typeof StampFile> => {
    try {
        return StampFile.parse(JSON.parse(readFileSync(join(packageRoot(import.meta.url), BUILD_INFO_FILE), "utf8")));
    } catch {
        // allow(silent-catch): only an image build writes the stamp; a checkout without one, or a stamp it cannot read, is an unstamped build.
        return {};
    }
};

let info: BuildInfo | undefined;

/** This process's build, read once. */
export const buildInfo = (env: NodeJS.ProcessEnv = process.env): BuildInfo => {
    if (info !== undefined) {
        return info;
    }
    const file = stamped();
    const commit = Stamp.parse(env["INTENTIC_COMMIT"]) ?? Stamp.parse(env["SOURCE_COMMIT"]) ?? file.commit;
    const id = buildId();
    const newest = Number(id.slice(id.lastIndexOf(":") + 1));
    const builtAt = file.builtAt ?? (newest > 0 ? new Date(newest).toISOString() : undefined);
    info = { version, ...opt("commit", commit), ...opt("builtAt", builtAt) };
    return info;
};

/** "0.0.0 (commit 1a2b3c4d5e6f)", for a log line. */
export const buildText = (build: BuildInfo): string => `${build.version}${build.commit === undefined ? "" : ` (commit ${build.commit.slice(0, 12)})`}`;

/** Test seam: forgets the build read. */
export const resetBuildInfo = (): void => {
    info = undefined;
};
