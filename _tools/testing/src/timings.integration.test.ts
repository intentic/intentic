import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timingArgs } from "./timings.js";

test("timing history is bounded, recent, malformed-tolerant and fail-open", () => {
    const directory = mkdtempSync(join(tmpdir(), "suite-timings-"));
    try {
        for (let index = 0; index < 30; index += 1) {
            const path = join(directory, `_example_pkg.unit.${String(index).padStart(2, "0")}.json`);
            writeFileSync(path, index === 29 ? "not json" : JSON.stringify({ "src/a.test.ts": index + 1 }));
            utimesSync(path, index, index);
        }
        writeFileSync(join(directory, "other.unit.99.json"), JSON.stringify({ "src/other.test.ts": 100 }));
        const args = timingArgs(directory, "@example/pkg", "unit");
        expect(args[0]).toStartWith(`--timings=${join(directory, "_example_pkg.unit.")}`);
        expect(args.at(-1)).toBe("--update-timings");
        expect(args).not.toContain(`--timings=${join(directory, "_example_pkg.unit.29.json")}`);
        expect(args).toContain(`--timings=${join(directory, "_example_pkg.unit.28.json")}`);
        expect(args).not.toContain(`--timings=${join(directory, "other.unit.99.json")}`);
        expect(args).toHaveLength(10);
        expect(readdirSync(directory).filter((name) => name.startsWith("_example_pkg.unit."))).toHaveLength(23);
        expect(timingArgs(join(directory, "missing/child"), "@example/pkg", "unit")).toHaveLength(2);
        expect(timingArgs(undefined, "@example/pkg", "unit")).toEqual([]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
