import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

// Vitest setup, not a helper: isolates each test's engine store (a real dir the daemon's own turns also use).
// Suites testing the store itself may still set their own dir per case; this is the floor, not a ceiling.

let fence: string | undefined;

beforeAll(() => {
    fence = mkdtempSync(join(tmpdir(), `intentic-engines-`));
    process.env["INTENTIC_ENGINES_DIR"] = fence;
});

afterAll(() => {
    if (fence !== undefined) {
        rmSync(fence, { recursive: true, force: true });
        fence = undefined;
    }
    delete process.env["INTENTIC_ENGINES_DIR"];
});
