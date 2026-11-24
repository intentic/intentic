import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/* Where the native compiler lives. */

let cached: string | undefined;

export const compilerExePath = (): string => {
    if (cached !== undefined) {
        return cached;
    }
    const here = createRequire(import.meta.url);
    const compiler = here.resolve("typescript/package.json");
    const platform = `@typescript/typescript-${process.platform}-${process.arch}`;
    const platformPkg = createRequire(compiler).resolve(`${platform}/package.json`);
    const exe = join(dirname(platformPkg), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
    if (!existsSync(exe)) {
        throw new Error(`the native TypeScript compiler is not installed for this platform (${exe} does not exist)`);
    }
    cached = exe;
    return exe;
};
