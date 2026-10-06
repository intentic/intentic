import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMissing } from "@intentic/base/errors";
import { z } from "zod";

// What runs a directory's tests, decided once: the panel list's "has tests" fact (panels/panels.routes.ts) and the
// command a test run starts (workspace/workspace.routes.ts) read this, so a repo offered a test run is one that has
// something to run it with.

export type TestRunner = "script" | "bun" | "vitest";

// The command each runner is started with.
export const TEST_COMMANDS = { script: "pnpm test", bun: "bun test", vitest: "pnpm vitest run" } as const satisfies Record<TestRunner, string>;

// A text file's contents, or undefined when it is not there; any other failed read is not an answer and is thrown.
const textOf = (path: string): string | undefined => {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
};

// Of a manifest, only the `test` script; anything else in it may be any shape.
const ManifestSchema = z.looseObject({ scripts: z.looseObject({ test: z.string().optional() }).optional() });

// Whether the directory's manifest names a `test` script; a manifest that does not parse, or names one that is not a
// string, names none.
const hasTestScript = (dir: string): boolean => {
    const manifest = textOf(join(dir, "package.json"));
    if (manifest === undefined) {
        return false;
    }
    try {
        return ManifestSchema.safeParse(JSON.parse(manifest)).data?.scripts?.test !== undefined;
    } catch (error) {
        if (error instanceof SyntaxError) {
            return false;
        }
        throw error;
    }
};

/**
 * The runner a directory's tests run under, or undefined when it has none: its own `test` script first, then a
 * runner's own config file (bunfig.toml, vitest.config.ts), then a workspace catalog naming vitest (a substring match,
 * not a parse) for a monorepo whose root runs nothing itself.
 */
export const testRunnerOf = (dir: string): TestRunner | undefined => {
    if (hasTestScript(dir)) {
        return "script";
    }
    if (existsSync(join(dir, "bunfig.toml"))) {
        return "bun";
    }
    if (existsSync(join(dir, "vitest.config.ts")) || (textOf(join(dir, "pnpm-workspace.yaml"))?.includes("vitest") ?? false)) {
        return "vitest";
    }
    return undefined;
};

/** The command that runs a directory's tests; one with no runner of its own is handed to vitest. */
export const testCommandOf = (dir: string): string => TEST_COMMANDS[testRunnerOf(dir) ?? "vitest"];
