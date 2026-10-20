import { runnerSlug } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import type { Services } from "../composition.js";
import { adoptDefinitionSettings } from "../definition/apply-definition.js";
import { emitDefinitionToml, parseDefinitionToml, settingsDefinition } from "../definition/definition.js";
import { runnerSummaries } from "./runner-peer.js";

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
    parentBase?: string;
    parentDigest?: string;
    runnerToml?: string;
    state?: Record<string, unknown>;
}): Services =>
    ({
        config: {
            sandbox: { image: "", baseImage: input.parentBase ?? "", baseDigest: input.parentDigest ?? "", channel: "", environmentHash: input.parentOverlayHash ?? "" },
        },
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

// The badge is buildParity (state/sandbox-build.ts) over the parent's stamped build and the runner's hello: the base by
// digest when both read one, the overlay by hash, and an overlay build's own tag never, since it names its container.
test("a runner's badge compares its announced base and overlay with the build this sandbox runs", async () => {
    const stable = "ghcr.io/intentic/sandbox:stable";
    const digest = `sha256:${"ab".repeat(32)}`;
    const parity = async (state: Record<string, unknown>): Promise<string | undefined> =>
        (await runnerSummaries(summaryServices({ parentBase: stable, parentDigest: digest, parentOverlayHash: "h1", state })))[0]?.parity;
    expect(await parity({ image: "intentic-sandbox-env-runner-omen:h1", baseImage: stable, baseDigest: digest, overlayHash: "h1" })).toBe("current");
    expect(await parity({ image: "intentic-sandbox-env-runner-omen:h1", baseImage: stable, baseDigest: `sha256:${"cd".repeat(32)}`, overlayHash: "h1" })).toBe("outdated");
    expect(await parity({ image: "intentic-sandbox-env-runner-omen:h2", baseImage: stable, baseDigest: digest, overlayHash: "h2" })).toBe("outdated");
    // A runner from before the hello named its base is measured by its own image; one started by hand names none.
    expect(await parity({ image: stable, overlayHash: "h1" })).toBe("current");
    expect(await parity({ image: "dev", overlayHash: "h1" })).toBe("unknown");
});
