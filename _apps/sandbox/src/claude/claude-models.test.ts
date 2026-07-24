import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import type { ClaudeStore } from "./claude-credentials.js";
import { createClaudeCatalog } from "./claude-models.js";

/* The catalog's FALLBACK LADDER — discovery → persisted last-known-good → alias floor. Discovery is injected
 * rather than suppressed by withholding a credential: the real one spawns the Claude Code CLI, which inherits the
 * ambient environment, so on any machine that has a logged-in CLI (every developer's, and this repo's own agent
 * sandbox) a credential-free catalog still returns the live list and the lower rungs are never exercised. */

const emptyStore = { list: async () => [] } as unknown as ClaudeStore;
const noContainerToken = { claudeCodeOauthToken: "" } as unknown as Config;
// Discovery that fails the way an unreachable/unauthenticated CLI does, so every read descends past the live tier.
const discoveryFails = async (): Promise<Model[]> => {
    throw new Error("claude code cli unavailable");
};

const catalogIn = async (persisted?: Model[]): Promise<{ models: Model[]; default: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));
    const persistPath = join(dir, "models.json");
    if (persisted !== undefined) {
        await writeFile(persistPath, JSON.stringify(persisted));
    }
    return createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, discoveryFails).models();
};

test("a successful discovery is written through, so the next offline read still has the new tier", async () => {
    const live: Model[] = [
        { id: "claude-fictional-9", label: "Claude Fictional 9", description: "A tier that postdates this build", badges: ["reasoning"] },
    ];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));
    const persistPath = join(dir, "models.json");

    const online = await createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, async () => live).models();
    expect(online.models).toEqual(live);

    // A separate catalog instance, so nothing is served from the in-memory cache — this reads the file the first
    // one wrote. Before persistence this fell to the aliases and the discovered tier was lost on every restart.
    const offline = await createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, discoveryFails).models();
    expect(offline.models).toEqual(live);
});

test("serves the persisted last-known-good catalog when discovery fails, presentation data intact", async () => {
    const recorded: Model[] = [
        { id: "claude-fictional-9", label: "Claude Fictional 9", description: "A tier that postdates this build", badges: ["reasoning"] },
        { id: "claude-fictional-9-fast", label: "Claude Fictional 9 Fast", badges: ["fast"] },
    ];

    const catalog = await catalogIn(recorded);

    // The whole point of persisting records rather than bare ids: a tier nobody hardcoded survives a restart with
    // its provider-supplied display name and description, instead of collapsing back to the alias floor.
    expect(catalog.models).toEqual(recorded);
    expect(catalog.default).toBe("claude-fictional-9");
});

test("falls back to the tier aliases when nothing has been persisted yet", async () => {
    const catalog = await catalogIn();

    expect(catalog.models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"]);
    expect(catalog.default).toBe("opus");
});

test("treats a corrupt or older-build persisted file as absent rather than serving it half-formed", async () => {
    // `label` missing is exactly the shape a pre-widening build would have left behind; the schema parse rejects
    // the whole file so the picker never renders a record it can't label.
    const catalog = await catalogIn([{ id: "claude-fictional-9" } as Model]);

    expect(catalog.models.map((model) => model.id)).toEqual(["opus", "sonnet", "haiku"]);
});

test("the default is the provider's own first-listed model, never a tier matched by name", async () => {
    // Opus deliberately sits last: the old catalog hardcoded a /opus/i preference, so a name-matching default
    // would pick it here. Order is the provider's opinion and is the only thing that stays correct on a rename.
    const catalog = await catalogIn([
        { id: "claude-haiku-9", label: "Claude Haiku 9" },
        { id: "claude-opus-9", label: "Claude Opus 9" },
    ]);

    expect(catalog.default).toBe("claude-haiku-9");
});
