// Pins the two things the warmer decides before it sends anything: which variables are the connector card's, and
// whether the install is the one this lockfile describes. The sending itself is turbo.test.mjs's ground.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheEnv, installMatchesLockfile } from "./warm.mjs";

test("the card's variables are found under whatever instance suffix they carry", () => {
    assert.deepEqual(cacheEnv({ TURBO_CACHE_URL_TURBO_CACHE: "http://127.0.0.1:9/gw/", TURBO_CACHE_TOKEN_TURBO_CACHE: "placeholder", TURBO_CACHE_TEAM_TURBO_CACHE: "fleet" }), {
        url: "http://127.0.0.1:9/gw",
        token: "placeholder",
        team: "fleet",
    });
    assert.deepEqual(cacheEnv({ TURBO_CACHE_URL: "https://cache", TURBO_CACHE_TOKEN: "t" }), { url: "https://cache", token: "t", team: "intentic" });
});

test("no card, or half of one, is no cache", () => {
    assert.equal(cacheEnv({}), undefined);
    assert.equal(cacheEnv({ TURBO_CACHE_URL_X: "https://cache" }), undefined);
    assert.equal(cacheEnv({ TURBO_CACHE_URL_X: "https://cache", TURBO_CACHE_TOKEN_Y: "t" }), undefined);
    assert.equal(cacheEnv({ TURBO_API: "https://cache", TURBO_TOKEN: "t" }), undefined);
});

test("an install matches its lockfile when pnpm's record is the lockfile, with or without pnpm 12's leading document", () => {
    const root = mkdtempSync(join(tmpdir(), "turbo-cache-warm-"));
    try {
        mkdirSync(join(root, "node_modules", ".pnpm"), { recursive: true });
        const body = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
        const lock = (text) => writeFileSync(join(root, "pnpm-lock.yaml"), text);
        writeFileSync(join(root, "node_modules", ".pnpm", "lock.yaml"), body);
        lock(body);
        assert.equal(installMatchesLockfile(root), true);
        lock(`---\nlockfileVersion: '9.0'\n\nimporters:\n  .:\n    packageManagerDependencies: {}\n\n---\n${body}`);
        assert.equal(installMatchesLockfile(root), true);
        lock(body.replace("{}", "{ dependencies: { a: 1 } }"));
        assert.equal(installMatchesLockfile(root), false);
        // A record that only ends the lockfile mid-line is not the same lockfile.
        lock(`x${body}`);
        assert.equal(installMatchesLockfile(root), false);
        rmSync(join(root, "node_modules"), { recursive: true });
        assert.equal(installMatchesLockfile(root), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
