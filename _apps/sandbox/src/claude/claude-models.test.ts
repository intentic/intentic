import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import type { ClaudeStore } from "./claude-credentials.js";
import { createClaudeCatalog } from "./claude-models.js";

/* The catalog's TWO-SOURCE MERGE (CLI tier aliases + REST /v1/models) and its FALLBACK LADDER — live merge →
 * persisted last-known-good → alias floor. Both sources are injected rather than suppressed by withholding a
 * credential: the real discovery spawns the Claude Code CLI, which inherits the ambient environment, so on any
 * machine that has a logged-in CLI (every developer's, and this repo's own agent sandbox) a credential-free
 * catalog still returns the live list and the lower rungs are never exercised. */

const emptyStore = { list: async () => [] } as unknown as ClaudeStore;
const noContainerToken = { claudeCodeOauthToken: "" } as unknown as Config;
// A container credential, so the REST rung actually runs (the store is empty, so this is the token it falls to).
const containerToken = { claudeCodeOauthToken: "oauth-token" } as unknown as Config;
// Discovery that fails the way an unreachable/unauthenticated CLI does, so every read descends past the live tier.
const discoveryFails = async (): Promise<Model[]> => {
    throw new Error("claude code cli unavailable");
};
// Both REST stubs keep the suite hermetic: the real fetch would reach api.anthropic.com from a unit test.
const apiReturns =
    (models: { id: string; display_name: string }[]): typeof fetch =>
    async () =>
        new Response(JSON.stringify({ data: models }), { status: 200 });
const apiFails: typeof fetch = async () => {
    throw new Error("network unreachable");
};

const catalogIn = async (persisted?: Model[]): Promise<{ models: Model[]; default: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));
    const persistPath = join(dir, "models.json");
    if (persisted !== undefined) {
        await writeFile(persistPath, JSON.stringify(persisted));
    }
    return createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, discoveryFails, apiFails).models();
};

test("a successful discovery is written through, so the next offline read still has the new tier", async () => {
    const live: Model[] = [
        { id: "claude-fictional-9", label: "Claude Fictional 9", description: "A tier that postdates this build", badges: ["reasoning"] },
    ];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));
    const persistPath = join(dir, "models.json");

    const online = await createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, async () => live, apiFails).models();
    expect(online.models).toEqual(live);

    // A separate catalog instance, so nothing is served from the in-memory cache — this reads the file the first
    // one wrote. Before persistence this fell to the aliases and the discovered tier was lost on every restart.
    const offline = await createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, discoveryFails, apiFails).models();
    expect(offline.models).toEqual(live);
});

test("merges the REST catalog's versioned models in after the CLI's tier aliases", async () => {
    // The regression this merge exists for: supportedModels() publishes only tier ALIASES, and an alias lags a
    // release — `opus` still resolved to claude-opus-4-8 while claude-opus-5 had shipped and was already serving
    // turns — so a picker sourced from the CLI alone could not reach the new model at all.
    const aliases: Model[] = [{ id: "opus", label: "Opus", description: "Opus 4.8 with 1M context" }];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));
    const catalog = await createClaudeCatalog(
        emptyStore,
        containerToken,
        dir,
        join(dir, "models.json"),
        async () => aliases,
        apiReturns([
            { id: "claude-opus-5", display_name: "Claude Opus 5" },
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
        ]),
    ).models();

    // Aliases lead (their order is the CLI's own, so models[0] stays its top preference); the versioned rows
    // follow, and they are the only rung that carries a version in the NAME rather than buried in a description.
    expect(catalog.models.map((model) => model.id)).toEqual(["opus", "claude-opus-5", "claude-opus-4-8"]);
    expect(catalog.models.find((model) => model.id === "claude-opus-5")?.label).toBe("Claude Opus 5");
    expect(catalog.default).toBe("opus");
});

test("drops the CLI's nameless `default` alias, so no pick can leave the chip unable to say what runs", async () => {
    // The CLI lists "Default (recommended)" FIRST and names no model in it — the version it resolves to is prose
    // inside `description`. Left in, it is both an unreadable row in the picker and the id every fresh session
    // lands on. Dropping it hands models[0] to the next alias, which still names its tier and still tracks
    // releases. Asserted at both live rungs: the merge below, and the persisted read further down.
    const aliases: Model[] = [
        { id: "default", label: "Default (recommended)", description: "Opus 4.8 with 1M context" },
        { id: "opus", label: "Opus" },
        { id: "haiku", label: "Haiku" },
    ];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));
    const persistPath = join(dir, "models.json");

    const catalog = await createClaudeCatalog(emptyStore, containerToken, dir, persistPath, async () => aliases, apiFails).models();

    expect(catalog.models.map((model) => model.id)).toEqual(["opus", "haiku"]);
    expect(catalog.default).toBe("opus");

    // A file recorded by an older build still carries the row; it is filtered on the way out too, so the offline
    // rung can't reintroduce what the live one just dropped.
    await writeFile(persistPath, JSON.stringify(aliases));
    const offline = await createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, discoveryFails, apiFails).models();

    expect(offline.models.map((model) => model.id)).toEqual(["opus", "haiku"]);
});

test("a REST failure costs the versioned rows, never the aliases the CLI already returned", async () => {
    const aliases: Model[] = [{ id: "opus", label: "Opus" }];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));

    const catalog = await createClaudeCatalog(emptyStore, containerToken, dir, join(dir, "models.json"), async () => aliases, apiFails).models();

    expect(catalog.models).toEqual(aliases);
});

test("serves the REST catalog alone when the CLI is unreachable, rather than falling to the floor", async () => {
    // An unauthenticated/unstartable CLI used to drop the read straight to the three hardcoded aliases. The REST
    // rung answers over plain HTTP, so it survives exactly the conditions that kill the CLI probe.
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));

    const catalog = await createClaudeCatalog(
        emptyStore,
        containerToken,
        dir,
        join(dir, "models.json"),
        discoveryFails,
        apiReturns([{ id: "claude-opus-5", display_name: "Claude Opus 5" }]),
    ).models();

    expect(catalog.models).toEqual([{ id: "claude-opus-5", label: "Claude Opus 5" }]);
    expect(catalog.default).toBe("claude-opus-5");
});

test("an id both sources report renders once, keeping the alias row that carries the metadata", async () => {
    const aliases: Model[] = [{ id: "claude-opus-5", label: "Opus", description: "Opus 5", badges: ["reasoning"] }];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));

    const catalog = await createClaudeCatalog(
        emptyStore,
        containerToken,
        dir,
        join(dir, "models.json"),
        async () => aliases,
        apiReturns([{ id: "claude-opus-5", display_name: "Claude Opus 5" }]),
    ).models();

    expect(catalog.models).toEqual(aliases);
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
