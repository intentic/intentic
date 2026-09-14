import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/* Where the native compiler lives. */

let cached: string | undefined;

export const tsgoExePath = (): string => {
    if (cached !== undefined) {
        return cached;
    }
    const here = createRequire(import.meta.url);
    const preview = here.resolve("@typescript/native-preview/package.json");
    const platform = `@typescript/native-preview-${process.platform}-${process.arch}`;
    const platformPkg = createRequire(preview).resolve(`${platform}/package.json`);
    const exe = join(dirname(platformPkg), "lib", process.platform === "win32" ? "tsgo.exe" : "tsgo");
    if (!existsSync(exe)) {
        throw new Error(`the native TypeScript compiler is not installed for this platform (${exe} does not exist)`);
    }
    cached = exe;
    return exe;
};
