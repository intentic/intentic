import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// A kind of in-flight work declared beside its store and missing from the boot's registry is work a restart loses in
// silence: its records sit on file and nothing reads them back. Read by shape off the source, as state-registry.test.ts
// reads the documents.

const SOURCE_ROOT = join(packageRoot(import.meta.url), "src");

const sources = async (dir: string): Promise<string[]> =>
    (
        await Promise.all(
            (await readdir(dir, { withFileTypes: true })).map(async (entry) => {
                const path = join(dir, entry.name);
                if (entry.isDirectory()) {
                    return sources(path);
                }
                return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testing.ts") ? [path] : [];
            }),
        )
    ).flat();

test("every in-flight kind declared in the daemon is listed in the boot's registry", async () => {
    const declared: string[] = [];
    for (const file of await sources(SOURCE_ROOT)) {
        for (const match of (await readFile(file, "utf8")).matchAll(/export const (\w+) = defineInFlight\(/g)) {
            declared.push(match[1] ?? "");
        }
    }
    // Guards against the pattern matching nothing, which would pass vacuously.
    expect(declared.length).toBeGreaterThan(5);
    const registry = await readFile(join(SOURCE_ROOT, "bootstrap/restart/in-flight-kinds.ts"), "utf8");
    const listed = registry.slice(registry.indexOf("const IN_FLIGHT"), registry.indexOf("];", registry.indexOf("const IN_FLIGHT")));
    expect(declared.filter((name) => !new RegExp(`^\\s*${name},`, "m").test(listed)).toSorted()).toEqual([]);
});
