import { runnerSlug, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { adoptDefinitionSettings } from "../definition/apply-definition.js";
import { emitDefinitionToml, parseDefinitionToml, settingsDefinition } from "../definition/definition.js";
import { runnerParity } from "./runner-parity.js";
import { runnerSummaries } from "./runner-peer.js";

// What a runner's row may say about its build: a badge and an update button. A false "outdated" nags about a healthy
// machine; a false "current" hides one that's actually behind.

const parent = { image: "ghcr.io/intentic/sandbox:2.3.1", channel: "stable", overlayHash: "abc123" };

test("a runner on the parent's image, channel and approved overlay is current", () => {
    expect(runnerParity(parent, { ...parent })).toBe("current");
});

test("any one axis moving is outdated, because each decides what code the turn runs", () => {
    expect(runnerParity(parent, { ...parent, image: "ghcr.io/intentic/sandbox:2.2.0" })).toBe("outdated");
    expect(runnerParity(parent, { ...parent, channel: "edge" })).toBe("outdated");
    expect(runnerParity(parent, { ...parent, overlayHash: "def456" })).toBe("outdated");
});

test("an overlay on one side only is a difference; neither side having one is not", () => {
    const stock = { image: parent.image, channel: parent.channel };
    expect(runnerParity({ ...stock }, { ...stock })).toBe("current");
    expect(runnerParity(parent, stock)).toBe("outdated");
    expect(runnerParity(stock, parent)).toBe("outdated");
});

// Twice over: a runner that never connected has nothing to compare, and a dev parent can't name its own image either.
test("nothing to compare, or nothing to compare against, reads as unknown rather than as a warning", () => {
    expect(runnerParity(parent, undefined)).toBe("unknown");
    expect(runnerParity(parent, { image: "" })).toBe("unknown");
    expect(runnerParity({ image: "" }, { image: "dev" })).toBe("unknown");
    expect(runnerParity({ image: "dev" }, { image: "dev" })).toBe("unknown");
});

// An overlay build's own tag carries its container's slug, so it differs on every pair of sandboxes by construction.
test("a runner built from the parent's overlay on the parent's base is current, whatever its own tag", () => {
    const base = "ghcr.io/intentic/sandbox:stable";
    const parentBuild = { image: "intentic-sandbox-env-sandbox-82789f4106b4:0e888b675bc7", baseImage: base, channel: "stable", overlayHash: "0e888b675bc7" };
    const runner = { image: "intentic-sandbox-env-runner-omen:0e888b675bc7", baseImage: base, channel: "stable", overlayHash: "0e888b675bc7" };
    expect(runnerParity(parentBuild, runner)).toBe("current");
    expect(runnerParity(parentBuild, { ...runner, baseImage: "ghcr.io/intentic/sandbox:edge" })).toBe("outdated");
    expect(runnerParity(parentBuild, { ...runner, overlayHash: "ffffffffffff" })).toBe("outdated");
});

// Each machine's `intentic-sandbox:dev` is whatever its checkout held, so the tag agreeing proves nothing, and an
// update can't bring it level: `ic` refuses to move a checkout build onto the published image (recreate.rs).
test("a build from a checkout on either side reads as unknown, never as outdated with an update that is refused", () => {
    const dev = "intentic-sandbox:dev";
    const parentDev = { image: "intentic-sandbox-dev-env-sandbox-82789f4106b4:0e888b675bc7", baseImage: dev, channel: "stable", overlayHash: "0e888b675bc7" };
    const runnerDev = { image: "intentic-sandbox-env-runner-omen:0e888b675bc7", baseImage: dev, overlayHash: "0e888b675bc7" };
    expect(runnerParity(parentDev, runnerDev)).toBe("unknown");
    expect(runnerParity(parent, runnerDev)).toBe("unknown");
    expect(runnerParity({ image: dev }, parent)).toBe("unknown");
});

// An image from before the hello carried `baseImage` is measured by `image`, as it always was.
test("a runner that announces no base is compared by its image", () => {
    expect(runnerParity(parent, { image: parent.image, channel: parent.channel, overlayHash: parent.overlayHash })).toBe("current");
    expect(runnerParity({ ...parent, baseImage: parent.image, image: "intentic-sandbox-env-sandbox-x:abc" }, parent)).toBe("current");
});

// Must match ic's own spelling (runner.rs SLUG_PREFIX), or the update/rebuild flow addresses a container that doesn't
// exist.
test("a runner's container is its name under ic's prefix", () => {
    expect(runnerSlug("rig")).toBe("runner-rig");
});

// The parity loop's two halves, tested without a socket: the parent's drift lines, and the runner's adopt. Adopting
// what the parent would send is what makes the drift go empty.

const summaryServices = (input: {
    parentSettings?: Record<string, unknown>;
    parentOverlayHash?: string;
    runnerToml?: string;
    state?: Record<string, unknown>;
}): Services =>
    ({
        config: { sandbox: { image: "", channel: "", environmentHash: input.parentOverlayHash ?? "" } },
        sandboxSettings: { get: async () => ({ ...input.parentSettings }) },
        runners: { list: async () => [{ id: "rig" }] },
        runnerHub: {
            // Never connected announces nothing; a connected runner carries its hello's claim beside the socket state.
            state: () =>
                input.state?.["image"] === undefined
                    ? { online: false }
                    : {
                          online: true,
                          announced: {
                              version: "0.0.0",
                              ...input.state,
                              ...(input.runnerToml === undefined ? {} : { definitionToml: input.runnerToml }),
                          },
                      },
        },
    }) as unknown as Services;

// A runner's hello claim, built by the same helper the real link uses, so this test moves with the format.
const runnerClaim = async (settings: Record<string, unknown>): Promise<string> =>
    emitDefinitionToml(await settingsDefinition({ sandboxSettings: { get: async () => settings } } as unknown as Services));

test("agreement is an EMPTY drift list, distinct from the absent one a silent runner gets", async () => {
    const toml = await runnerClaim({ hashlineEdits: true });
    const agreeing = await runnerSummaries(
        summaryServices({
            parentSettings: { hashlineEdits: true },
            parentOverlayHash: "h1",
            runnerToml: toml,
            state: { image: "img", overlayHash: "h1" },
        }),
    );
    expect(agreeing[0]?.drift).toEqual([]);

    const silent = await runnerSummaries(summaryServices({ state: {} }));
    expect(silent[0]?.drift).toBeUndefined();
});

test("a differing overlay hash and a differing setting each earn their line, with their own remedies", async () => {
    const toml = await runnerClaim({});
    const summaries = await runnerSummaries(
        summaryServices({
            parentSettings: { hashlineEdits: true },
            parentOverlayHash: "h1",
            runnerToml: toml,
            state: { image: "img", overlayHash: "h2" },
        }),
    );
    const drift = summaries[0]?.drift ?? [];
    expect(drift.map((line) => line.subject)).toEqual(["Environment overlay", "Setting hashlineEdits"]);
    // Overlay's remedy is a rebuild; the setting's is the sync door, keyed off the "Setting " subject prefix.
    expect(drift[0]?.detail?.length).toBeGreaterThan(0);
    expect(drift[1]?.detail?.length).toBeGreaterThan(0);
    expect(drift[0]?.detail).not.toBe(drift[1]?.detail);
});

test("a claim that does not parse costs its drift lines, never the list", async () => {
    const summaries = await runnerSummaries(summaryServices({ parentOverlayHash: "", runnerToml: "not = [valid", state: { image: "img" } }));
    expect(summaries[0]?.drift?.map((line) => line.subject)).toEqual(["Declared settings"]);
});

test("adopt REPLACES: an omitted key returns to its default, and adopting the parent's claim ends the drift", async () => {
    let stored: Record<string, unknown> | undefined;
    const runner = {
        sandboxSettings: {
            get: async () => stored ?? { iqSearch: true },
            set: async (settings: Record<string, unknown>) => {
                stored = settings;
            },
        },
    } as unknown as Services;

    // The parent's claim omits iqSearch and sets hashlineEdits; the runner starts with the opposite.
    const parentClaim = await runnerClaim({ hashlineEdits: true });
    const applied = await adoptDefinitionSettings(runner, parseDefinitionToml(parentClaim));
    expect(applied).toEqual(["hashlineEdits"]);
    expect(stored?.["hashlineEdits"]).toBe(true);
    expect(stored?.["iqSearch"]).toBe(SandboxSettingsSchema.parse({}).iqSearch);

    expect(await runnerClaim(stored ?? {})).toBe(parentClaim);
});
