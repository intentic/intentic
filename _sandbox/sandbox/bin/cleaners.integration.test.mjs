import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { secretValues } from "./cleaners.mjs";

test("secretValues reads the descriptor-backed store and preserves its reference name", () => {
    const root = mkdtempSync(join(tmpdir(), "cleaner-secrets-"));
    try {
        const repo = join(root, "desired-state");
        mkdirSync(repo, { recursive: true });
        writeFileSync(join(repo, ".env"), "CUSTOM_CREDENTIAL=a1b2c3d4e5f6g7h8i9j0k1\n");

        expect(secretValues({ WORKSPACE_ROOT: root })).toEqual([{ target: "a1b2c3d4e5f6g7h8i9j0k1", replacement: "{{secret:CUSTOM_CREDENTIAL}}" }]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
