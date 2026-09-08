import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { CLAUDE_SDK_EXPORTS } from "../../engines/engine-descriptors.js";
import { forgetEngineResolution } from "../../engines/engine-resolve.js";
import { activateVersion, engineVersionDir, forgetEngineStates, readEngineState } from "../../engines/engine-store.js";
import { claudeCliPath, forgetClaudeSdk, refreshClaudeSdk, sdk } from "./claude-sdk.js";

// The loader decides which SDK copy every turn runs on. A store copy is taken whole (JS + CLI binary from one prefix);
// a bad copy (missing an export the daemon calls) is refused permanently rather than failing mid-turn.

const writeStoreSdk = (version: string, exports: readonly string[]): void => {
    const pkgDir = join(engineVersionDir("claude", version), "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const binDir = join(engineVersionDir("claude", version), "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`);
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
    // A stand-in module; tests the loader's contract with a version, not the SDK's own behavior.
    writeFileSync(
        join(pkgDir, "sdk.mjs"),
        `${exports.map((name) => `export const ${name} = ${name === "USAGE_LIMIT_ERROR_PREFIXES" ? `["fixture"]` : `() => "${version}"`};`).join("\n")}\n`,
    );
};

beforeEach(() => {
    process.env["INTENTIC_ENGINES_DIR"] = mkdtempSync(join(tmpdir(), "claude-sdk-"));
    forgetEngineStates();
    forgetEngineResolution();
    forgetClaudeSdk();
});

test("with an empty store the image's own copy answers, and no path is named for it", async () => {
    expect(await refreshClaudeSdk()).toEqual({ source: "image" });
    expect(claudeCliPath()).toBeUndefined();
    expect(sdk().query).toBeTypeOf("function");
});

test("an active store version supplies both halves from the one prefix", async () => {
    writeStoreSdk("0.3.999", CLAUDE_SDK_EXPORTS);
    await activateVersion("claude", "0.3.999");
    forgetEngineResolution();

    expect(await refreshClaudeSdk()).toEqual({ source: "store", version: "0.3.999" });
    expect((sdk() as unknown as { query: () => string }).query()).toBe("0.3.999");
    expect(claudeCliPath()).toBe(
        join(
            engineVersionDir("claude", "0.3.999"),
            "node_modules",
            "@anthropic-ai",
            `claude-agent-sdk-${process.platform}-${process.arch}`,
            "claude",
        ),
    );
});

// Quarantined rather than skipped, or the same failed import would be paid and logged once per turn forever, since the
// daemon calls these names on every turn.
test("a version missing an export the daemon calls is refused and recorded", async () => {
    writeStoreSdk(
        "0.3.998",
        CLAUDE_SDK_EXPORTS.filter((name) => name !== "getSessionMessages"),
    );
    await activateVersion("claude", "0.3.998");
    forgetEngineResolution();

    expect(await refreshClaudeSdk()).toEqual({ source: "image" });
    const state = await readEngineState("claude");
    expect(state.active).toBeUndefined();
    expect(state.quarantined[0]?.reason).toContain("getSessionMessages");
    // And the image's copy is what the daemon goes on calling.
    expect(sdk().query).toBeTypeOf("function");
});

// A revert on the card reaches the next turn without a restart; going back to the image is just a refresh away.
test("dropping the store's version returns the process to the image's copy", async () => {
    writeStoreSdk("0.3.999", CLAUDE_SDK_EXPORTS);
    await activateVersion("claude", "0.3.999");
    forgetEngineResolution();
    await refreshClaudeSdk();

    process.env["INTENTIC_ENGINES_DIR"] = mkdtempSync(join(tmpdir(), "claude-sdk-empty-"));
    forgetEngineStates();
    forgetEngineResolution();

    expect(await refreshClaudeSdk()).toEqual({ source: "image" });
    expect(claudeCliPath()).toBeUndefined();
});
