import { runnerSlug, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { adoptDefinitionSettings } from "../portability/apply-definition.js";
import { emitDefinitionToml, parseDefinitionToml, settingsDefinition } from "../portability/definition.js";
import { runnerParity } from "./runner-parity.js";
import { runnerSummaries } from "./runner.routes.js";

/* What a runner's row is allowed to say about its build. Every case here decides a badge and an update button,
 * and the two wrong answers cost opposite things: a false "outdated" nags about a machine that is fine, and a
 * false "current" leaves a runner months behind the parent looking healthy while its link errors read as
 * network trouble. */

const parent = { image: "ghcr.io/intentic/sandbox:2.3.1", channel: "stable", overlayHash: "abc123" };

test("a runner on the parent's image, channel and approved overlay is current", () => {
    expect(runnerParity(parent, { ...parent })).toBe("current");
});

test("any one axis moving is outdated, because each decides what code the turn runs", () => {
    expect(runnerParity(parent, { ...parent, image: "ghcr.io/intentic/sandbox:2.2.0" })).toBe("outdated");
    expect(runnerParity(parent, { ...parent, channel: "edge" })).toBe("outdated");
    expect(runnerParity(parent, { ...parent, overlayHash: "def456" })).toBe("outdated");
});

/* An overlay the owner added to the parent and not to the runner differs in exactly the way a turn notices,
 * when the tool it installed is missing. Neither side having one is agreement, not a gap. */
test("an overlay on one side only is a difference; neither side having one is not", () => {
    const stock = { image: parent.image, channel: parent.channel };
    expect(runnerParity({ ...stock }, { ...stock })).toBe("current");
    expect(runnerParity(parent, stock)).toBe("outdated");
    expect(runnerParity(stock, parent)).toBe("outdated");
});

/* UNKNOWN IS A REAL ANSWER, twice over: a runner that has never connected has told us nothing to compare, and
 * a dev parent cannot name its own image, so a warning drawn from either would be one nobody can act on. */
test("nothing to compare, or nothing to compare against, reads as unknown rather than as a warning", () => {
    expect(runnerParity(parent, undefined)).toBe("unknown");
    expect(runnerParity(parent, { image: "" })).toBe("unknown");
    expect(runnerParity({ image: "" }, { image: "dev" })).toBe("unknown");
    expect(runnerParity({ image: "dev" }, { image: "dev" })).toBe("unknown");
});

/* The container name the update and rebuild flows address a runner by. It has to be `ic`'s own spelling
 * (runner.rs SLUG_PREFIX): a mismatch sends the flow at a container that does not exist and reports "no such
 * sandbox" about a runner sitting right there in the list. */
test("a runner's container is its name under ic's prefix", () => {
    expect(runnerSlug("rig")).toBe("runner-rig");
});

/* THE PARITY LOOP, both halves without a socket: the parent's drift lines (what a runner's card says when its
 * environment or settings differ from this sandbox's) and the runner's adopt (what the sync door does to its
 * settings store). Together they are the loop's invariant: adopt what the parent would send, and the drift
 * lines go empty. */

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
            state: () => ({ online: true, ...input.state }),
            definitionToml: () => input.runnerToml,
        },
    }) as unknown as Services;

// A runner's hello claim, built by the same helper the real link uses, so this test moves with the format.
const runnerClaim = async (settings: Record<string, unknown>): Promise<string> =>
    emitDefinitionToml(await settingsDefinition({ sandboxSettings: { get: async () => settings } } as unknown as Services));

test("agreement is an EMPTY drift list, distinct from the absent one a silent runner gets", async () => {
    const toml = await runnerClaim({ terseOutput: true });
    const agreeing = await runnerSummaries(
        summaryServices({
            parentSettings: { terseOutput: true },
            parentOverlayHash: "h1",
            runnerToml: toml,
            state: { image: "img", overlayHash: "h1" },
        }),
    );
    expect(agreeing[0]?.drift).toEqual([]);

    // Never connected: no image in the state, nothing to compare — absent, so the card stays quiet instead
    // of claiming an agreement nobody measured.
    const silent = await runnerSummaries(summaryServices({ state: {} }));
    expect(silent[0]?.drift).toBeUndefined();
});

test("a differing overlay hash and a differing setting each earn their line, with their own remedies", async () => {
    const toml = await runnerClaim({});
    const summaries = await runnerSummaries(
        summaryServices({
            parentSettings: { terseOutput: true },
            parentOverlayHash: "h1",
            runnerToml: toml,
            state: { image: "img", overlayHash: "h2" },
        }),
    );
    const drift = summaries[0]?.drift ?? [];
    expect(drift.map((line) => line.subject)).toEqual(["Environment overlay", "Setting terseOutput"]);
    // The overlay's remedy is a rebuild (remove and re-add); the setting's is the sync door, which the UI
    // keys off the "Setting " subject prefix.
    expect(drift[0]?.detail).toContain("Remove and re-add");
});

test("a claim that does not parse costs its drift lines, never the list", async () => {
    const summaries = await runnerSummaries(summaryServices({ parentOverlayHash: "", runnerToml: "not = [valid", state: { image: "img" } }));
    expect(summaries[0]?.drift?.map((line) => line.subject)).toEqual(["Declared settings"]);
});

test("adopt REPLACES: an omitted key returns to its default, and adopting the parent's claim ends the drift", async () => {
    let stored: Record<string, unknown> | undefined;
    const runner = {
        sandboxSettings: {
            get: async () => stored ?? { hashlineEdits: true },
            set: async (settings: Record<string, unknown>) => {
                stored = settings;
            },
        },
    } as unknown as Services;

    // The parent stopped setting hashlineEdits and turned terseOutput on; the runner had the opposite.
    const parentClaim = await runnerClaim({ terseOutput: true });
    const applied = await adoptDefinitionSettings(runner, parseDefinitionToml(parentClaim));
    expect(applied).toEqual(["terseOutput"]);
    expect(stored?.["terseOutput"]).toBe(true);
    // Replace semantics, the whole point: the key the definition omits is BACK AT DEFAULT, not kept.
    expect(stored?.["hashlineEdits"]).toBe(SandboxSettingsSchema.parse({}).hashlineEdits);

    // And the loop closes: the runner's next claim equals the parent's, so the drift lines are gone.
    expect(await runnerClaim(stored ?? {})).toBe(parentClaim);
});
