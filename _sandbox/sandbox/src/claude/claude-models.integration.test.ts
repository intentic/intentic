import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SEED_MODELS, type Model } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Config } from "../env.config.js";
import type { ClaudeStore } from "./claude-credentials.js";
import { createClaudeCatalog } from "./claude-models.js";

/* The catalog's TWO-SOURCE MERGE (CLI tier aliases + REST /v1/models) and its FALLBACK LADDER: live merge →
 * persisted last-known-good → seed floor. Both sources are injected rather than suppressed by withholding a
 * credential: the real discovery spawns the Claude Code CLI, which inherits the ambient environment, so on any
 * machine that has a logged-in CLI (every developer's, and this repo's own agent sandbox) a credential-free
 * catalog still returns the live list and the lower rungs are never exercised.
 *
 * The rule every test below turns on: ONLY ROWS THAT NAME A VERSION are offered. Aliases are mined for the
 * effort levels and badges they alone publish, then dropped. */

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

    // A separate catalog instance, so nothing is served from the in-memory cache: this reads the file the first
    // one wrote. Before persistence this fell to the aliases and the discovered tier was lost on every restart.
    const offline = await createClaudeCatalog(emptyStore, noContainerToken, dir, persistPath, discoveryFails, apiFails).models();
    expect(offline.models).toEqual(live);
});

test("offers the REST catalog's versioned models and no tier alias at all", async () => {
    // The regression the REST source exists for: supportedModels() publishes only tier ALIASES, and an alias lags
    // a release: `opus` still resolved to claude-opus-4-8 while claude-opus-5 had shipped and was already serving
    // turns, so a picker sourced from the CLI alone could not reach the new model at all. And an alias ROW can
    // never say which version answered a turn, so the picker offers versions only.
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

    // `opus[1m]` carries a digit but no version: the numeric-SEGMENT test is what tells a context-window suffix
    // apart from a version, so it goes the way of `default` and `opus`.
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-opus-5", "claude-opus-4-8"]);
    expect(catalog.models.map((model) => model.label)).toEqual(["Claude Opus 5", "Claude Opus 4.8"]);
    // The REST order (newest first) is the provider's own, so the default a fresh chat lands on names a version.
    expect(catalog.default).toBe("claude-opus-5");
});

test("versioned rows inherit the effort levels and badges only the tier alias publishes", async () => {
    // Dropping the alias rows must not drop the composer's effort control with them: supportedModels() is the one
    // source for effort levels and capability flags, and it reports them per TIER, so every version of that tier
    // inherits them. A family the CLI offers no alias for (fable here) carries none: the honest answer, since
    // nothing published any. The alias `description` is NOT inherited: it describes one version, not the family.
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
    // The CLI answered, but nothing it published names a version, so there is no catalog to serve and the read
    // falls through to the persisted last-known-good, which does.
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

test("falls back to the seed floor when nothing has been persisted yet", async () => {
    const catalog = await catalogIn();

    // The floor the contract publishes: versioned like every other rung, so even a daemon that has never
    // reached either source offers models the user can name.
    expect(catalog.models).toEqual(CLAUDE_SEED_MODELS);
    expect(catalog.default).toBe(CLAUDE_SEED_MODELS[0]!.id);
});

test("treats a corrupt or older-build persisted file as absent rather than serving it half-formed", async () => {
    // `label` missing is exactly the shape a pre-widening build would have left behind; the schema parse rejects
    // the whole file so the picker never renders a record it can't label.
    const catalog = await catalogIn([{ id: "claude-fictional-9" } as Model]);

    expect(catalog.models).toEqual(CLAUDE_SEED_MODELS);
});

test("a persisted file carrying tier aliases can't put an unnameable row back in the picker", async () => {
    // The file is untrusted disk state (which is why it is schema-parsed at all), so the versioned test runs on
    // the way out too: only the versioned record survives, and the aliases beside it are dropped.
    const catalog = await catalogIn([
        { id: "opus", label: "Opus" },
        { id: "claude-opus-5", label: "Claude Opus 5" },
        { id: "haiku", label: "Haiku" },
    ]);

    expect(catalog.models).toEqual([{ id: "claude-opus-5", label: "Claude Opus 5" }]);
    expect(catalog.default).toBe("claude-opus-5");
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
