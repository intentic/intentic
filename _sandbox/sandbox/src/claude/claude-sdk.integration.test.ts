import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { CLAUDE_SDK_EXPORTS } from "../engines/engine-descriptors.js";
import { forgetEngineResolution } from "../engines/engine-resolve.js";
import { activateVersion, engineVersionDir, forgetEngineStates, readEngineState } from "../engines/engine-store.js";
import { claudeCliPath, forgetClaudeSdk, refreshClaudeSdk, sdk } from "./claude-sdk.js";

/* THE LOADER, which is the piece with the most to lose: it decides which copy of the SDK every turn in this
 * sandbox runs on, and its wrong answers are not cosmetic. Two of them matter enough to pin.
 *
 * A STORE COPY IS TAKEN WHOLE. The JS half and the CLI binary come from the same installed prefix, because a
 * store binary under an image SDK is a pairing nobody upstream has ever run.
 *
 * A BAD COPY IS REFUSED, PERMANENTLY, AND THE IMAGE KEEPS SERVING TURNS. An SDK that has dropped an export the
 * daemon calls would otherwise fail deep inside a turn, at whichever call site got there first, on every turn
 * until somebody noticed. */

const writeStoreSdk = (version: string, exports: readonly string[]): void => {
    const pkgDir = join(engineVersionDir("claude", version), "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const binDir = join(engineVersionDir("claude", version), "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}`);
    mkdirSync(pkgDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\necho fixture\n", { mode: 0o755 });
    // A stand-in module: what is being tested is the loader's contract with a version, not the SDK's behaviour.
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

/* The refusal is what makes tracking upstream safe: the daemon calls these names, so a version that has stopped
 * exporting one of them can never serve a turn. It is quarantined rather than merely skipped, or the same
 * failed import would be paid, and logged, once per turn forever. */
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

// Going back to the image is a refresh away, so a revert on the card reaches the next turn without a restart.
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
