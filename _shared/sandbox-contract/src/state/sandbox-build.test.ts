import { DEV_SANDBOX_IMAGE } from "../policy/overlay-lint.js";
import { buildParity, builtFromCheckout, rebuildPending, type RunningSandbox, type SandboxBuild, sameBuild, swapVerdict } from "./sandbox-build.js";

// Every "which build" question is one of these, asked of two SandboxBuild records; a surface that compares fields of its
// own choosing is how "pending rebuild" outlived a rebuild and a runner read outdated for good (2026-10).

const stable = "ghcr.io/intentic/sandbox:stable";
const digest = (byte: string): string => `sha256:${byte.repeat(64)}`;

test("a rebuild is pending exactly when the overlay wanted is not the one running", () => {
    expect(rebuildPending("h1", "h1")).toBe(false);
    expect(rebuildPending("h2", "h1")).toBe(true);
    // A stock container wanting an overlay waits for it; one wanting none waits for nothing, whatever it runs.
    expect(rebuildPending("h1", undefined)).toBe(true);
    expect(rebuildPending(undefined, undefined)).toBe(false);
    expect(rebuildPending(undefined, "h1")).toBe(false);
});

test("a runner on the parent's base and overlay is current, and either moving is outdated", () => {
    const parent: SandboxBuild = { base: stable, overlay: "abc123" };
    expect(buildParity(parent, { ...parent })).toBe("current");
    expect(buildParity(parent, { ...parent, overlay: "def456" })).toBe("outdated");
    expect(buildParity(parent, { ...parent, base: "ghcr.io/intentic/sandbox:2.2.0" })).toBe("outdated");
});

test("an overlay on one side only is a difference; neither side having one is not", () => {
    expect(buildParity({ base: stable }, { base: stable })).toBe("current");
    expect(buildParity({ base: stable, overlay: "abc" }, { base: stable })).toBe("outdated");
    expect(buildParity({ base: stable }, { base: stable, overlay: "abc" })).toBe("outdated");
});

// One tag is one name for whatever the registry held when each machine pulled it; the digest is the build.
test("the base is compared by digest when both sides read one, and by its reference otherwise", () => {
    expect(buildParity({ base: stable, baseDigest: digest("a") }, { base: stable, baseDigest: digest("b") })).toBe("outdated");
    expect(buildParity({ base: stable, baseDigest: digest("a") }, { base: "ghcr.io/intentic/sandbox:beta", baseDigest: digest("a") })).toBe("current");
    expect(buildParity({ base: stable, baseDigest: digest("a") }, { base: stable })).toBe("current");
    expect(buildParity({ base: stable, baseDigest: digest("a") }, { base: "ghcr.io/intentic/sandbox:beta" })).toBe("outdated");
});

// Each machine's `intentic-sandbox:dev` is whatever its checkout held, so the name agreeing proves nothing, and an update
// cannot bring it level: `ic` refuses to move a checkout build onto the published image (recreate.rs).
test("nothing to compare, or a build from a checkout on either side, reads as unknown rather than as a warning", () => {
    const parent: SandboxBuild = { base: stable, overlay: "abc" };
    expect(buildParity(parent, undefined)).toBe("unknown");
    expect(buildParity(parent, { base: "" })).toBe("unknown");
    expect(buildParity({ base: "" }, parent)).toBe("unknown");
    expect(buildParity({ base: DEV_SANDBOX_IMAGE, overlay: "abc" }, { base: DEV_SANDBOX_IMAGE, overlay: "abc" })).toBe("unknown");
    expect(buildParity(parent, { base: DEV_SANDBOX_IMAGE, overlay: "abc" })).toBe("unknown");
});

// A rollback pin is a local tag too, and a rolled-back sandbox rejoins its channel by updating, not by a checkout.
test("only the dogfood base is a build from a checkout", () => {
    expect(builtFromCheckout({ base: DEV_SANDBOX_IMAGE })).toBe(true);
    expect(builtFromCheckout({ base: stable })).toBe(false);
    expect(builtFromCheckout({ base: "intentic-sandbox-rollback-demo:f6e917ce9b90" })).toBe(false);
    expect(builtFromCheckout({ base: "" })).toBe(false);
});

// A swap is told landed by what answers, never by the version: a checkout build is 0.0.0 before and after, and an update
// of one followed by "the version moved" waited out its deadline and said the sandbox never came back (2026-10).
const running = (build: SandboxBuild, bootedAt: number): RunningSandbox => ({ build, bootedAt });

test("two builds are the same only when something can tell, and differ the moment the overlay or digest does", () => {
    expect(sameBuild({ base: stable, baseDigest: digest("a") }, { base: stable, baseDigest: digest("a") })).toBe(true);
    expect(sameBuild({ base: stable, baseDigest: digest("a") }, { base: stable, baseDigest: digest("b") })).toBe(false);
    expect(sameBuild({ base: stable, overlay: "h1" }, { base: stable, overlay: "h2" })).toBe(false);
    expect(sameBuild({ base: stable }, { base: "ghcr.io/intentic/sandbox:beta" })).toBe(false);
    expect(sameBuild({ base: stable }, { base: stable })).toBeUndefined();
    expect(sameBuild({ base: DEV_SANDBOX_IMAGE }, { base: DEV_SANDBOX_IMAGE })).toBeUndefined();
});

test("an update of a checkout build lands on the new boot, though every version reads 0.0.0", () => {
    const from = running({ base: DEV_SANDBOX_IMAGE }, 1000);
    expect(swapVerdict({ from }, from)).toBe("waiting");
    expect(swapVerdict({ from }, running({ base: DEV_SANDBOX_IMAGE }, 2000))).toBe("landed");
});

test("an update of a release lands when the digest moves, and a new boot on the old digest came back unmoved", () => {
    const from = running({ base: stable, baseDigest: digest("a") }, 1000);
    expect(swapVerdict({ from }, running({ base: stable, baseDigest: digest("b") }, 2000))).toBe("landed");
    expect(swapVerdict({ from }, running({ base: stable, baseDigest: digest("a") }, 2000))).toBe("unmoved");
    expect(swapVerdict({ from }, from)).toBe("waiting");
    // A rollback names another tag: moved, digest or not.
    expect(swapVerdict({ from: running({ base: stable }, 1000) }, running({ base: "ghcr.io/intentic/sandbox:0.9.0" }, 1000))).toBe("landed");
});

test("a rebuild lands on its overlay, and a new boot on any other overlay came back without it", () => {
    const from = running({ base: stable, overlay: "old" }, 1000);
    expect(swapVerdict({ from, overlay: "new" }, running({ base: stable, overlay: "new" }, 2000))).toBe("landed");
    expect(swapVerdict({ from, overlay: "new" }, running({ base: stable, overlay: "old" }, 2000))).toBe("unmoved");
    expect(swapVerdict({ from, overlay: "new" }, from)).toBe("waiting");
    // Pressed with nothing read: only the overlay can say.
    expect(swapVerdict({ from: undefined, overlay: "new" }, running({ base: stable, overlay: "new" }, 2000))).toBe("landed");
    expect(swapVerdict({ from: undefined }, running({ base: stable }, 2000))).toBe("waiting");
});
