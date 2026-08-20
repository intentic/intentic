import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/* Where the native compiler lives. The `tsgo` executable ships in a platform-specific package
 * (`@typescript/native-preview-<platform>-<arch>`) that is a dependency of `@typescript/native-preview`,
 * which is a dependency of THIS package, so resolution is anchored here, in two hops, and works wherever
 * this package is installed (the repo's own node_modules, or the sandbox image's baked tree). Neither
 * package exports the binary path, so the second hop resolves the platform package's package.json (its one
 * export) and walks to the executable beside it, the same walk the wrapper's own `getExePath` performs. */

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
