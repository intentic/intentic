import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SEED_MODELS, type Model } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Config } from "../../env.config.js";
import type { ClaudeStore } from "./claude-credentials.js";
import { createClaudeCatalog } from "./claude-models.js";

// Catalog's two-source merge (CLI aliases + REST /v1/models), falling live merge to persisted last-known-good to seed
// floor. Every test's rule: only rows naming a version are offered; aliases are mined for effort/badges, then dropped.

const emptyStore = { list: async () => [] } as unknown as ClaudeStore;
const noContainerToken = { claudeCodeOauthToken: "" } as unknown as Config;
// Container credential the REST rung falls to, since the store is empty.
const containerToken = { claudeCodeOauthToken: "oauth-token" } as unknown as Config;
// Fails the way an unreachable or unauthenticated CLI does, so every read descends past the live tier.
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

    // A separate catalog instance avoids the in-memory cache; this reads the file the first one wrote.
    const offline = await createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, discoveryFails, apiFails).models();
    expect(offline.models).toEqual(live);
});

test("offers the REST catalog's versioned models and no tier alias at all", async () => {
    // An alias row can't say which version served a turn, so the picker offers only versioned rows.
    const aliases: Model[] = [
        { id: "default", label: "Default (recommended)", description: "Opus 4.8 with 1M context" },
        { id: "opus[1m]", label: "Opus (1M context)" },
        { id: "opus", label: "Opus", description: "Opus 4.8 with 1M context" },
    ];
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

    // opus[1m] has a digit but no version segment, so it drops like the other aliases.
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    expect(catalog.models.map((model) => model.label)).toEqual(["Claude Opus 5", "Claude Opus 4.8"]);
    // Default follows the REST order (newest first), the provider's own ordering.
    expect(catalog.default).toBe("claude-opus-5");
});

test("versioned rows inherit the effort levels and badges only the tier alias publishes", async () => {
    // Effort levels and badges come from the alias per tier, inherited by every version; the description is not.
    const aliases: Model[] = [
        { id: "opus", label: "Opus", description: "Opus 4.8 with 1M context", efforts: ["low", "high", "max"], badges: ["reasoning"] },
        { id: "haiku", label: "Haiku", efforts: ["low"], badges: ["fast"] },
    ];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));

    const catalog = await createClaudeCatalog(
        emptyStore,
        containerToken,
        dir,
        join(dir, "models.json"),
        async () => aliases,
        apiReturns([
            { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
            { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
            { id: "claude-fable-5", display_name: "Claude Fable 5" },
        ]),
    ).models();

    expect(catalog.models).toEqual([
        { id: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: ["low", "high", "max"], badges: ["reasoning"] },
        { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", efforts: ["low"], badges: ["fast"] },
        { id: "claude-fable-5", label: "Claude Fable 5" },
    ]);
});

test("a REST failure descends the ladder rather than serving the aliases the CLI returned", async () => {
    // Nothing the CLI published names a version, so the read falls to the persisted last-known-good instead.
    const recorded: Model[] = [{ id: "claude-opus-5", label: "Claude Opus 5" }];
    const dir = await mkdtemp(join(tmpdir(), "claude-models-"));
    const persistPath = join(dir, "models.json");
    await writeFile(persistPath, JSON.stringify(recorded));

    const catalog = await createClaudeCatalog(
        emptyStore,
        containerToken,
        dir,
        persistPath,
        async () => [{ id: "opus", label: "Opus" }],
        apiFails,
    ).models();

    expect(catalog.models).toEqual(recorded);
});

test("serves the REST catalog alone when the CLI is unreachable, rather than falling to the floor", async () => {
    // The REST rung answers over plain HTTP, so it survives the conditions that kill the CLI probe.
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

    // Persisting full records, not bare ids, lets an unhardcoded tier survive a restart with its display data.
    expect(catalog.models).toEqual(recorded);
    expect(catalog.default).toBe("claude-fictional-9");
});

test("falls back to the seed floor when nothing has been persisted yet", async () => {
    const catalog = await catalogIn();

    // Seed floor is versioned like every rung, so a daemon that reached neither source offers nameable models.
    expect(catalog.models).toEqual(CLAUDE_SEED_MODELS);
    expect(catalog.default).toBe(CLAUDE_SEED_MODELS[0]!.id);
});

test("treats a corrupt or older-build persisted file as absent rather than serving it half-formed", async () => {
    // Missing label matches a pre-widening file shape; the schema parse rejects the whole file, not just the row.
    const catalog = await catalogIn([{ id: "claude-fictional-9" } as Model]);

    expect(catalog.models).toEqual(CLAUDE_SEED_MODELS);
});

test("a persisted file carrying tier aliases can't put an unnameable row back in the picker", async () => {
    // Persisted disk state is untrusted, so the versioned-only rule applies on the way out too.
    const catalog = await catalogIn([
        { id: "opus", label: "Opus" },
        { id: "claude-opus-5", label: "Claude Opus 5" },
        { id: "haiku", label: "Haiku" },
    ]);

    expect(catalog.models).toEqual([{ id: "claude-opus-5", label: "Claude Opus 5" }]);
    expect(catalog.default).toBe("claude-opus-5");
});

test("the default is the provider's own first-listed model, never a tier matched by name", async () => {
    // Opus sits last on purpose: the default follows list order, the provider's own, not a name match.
    const catalog = await catalogIn([
        { id: "claude-haiku-9", label: "Claude Haiku 9" },
        { id: "claude-opus-9", label: "Claude Opus 9" },
    ]);

    expect(catalog.default).toBe("claude-haiku-9");
});
