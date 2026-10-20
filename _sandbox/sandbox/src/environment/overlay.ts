import { queueOnFile } from "@intentic/base/fs";
import { isOfficialSandboxImage } from "@intentic/sandbox-contract/policy/overlay-lint";
import type { Environment } from "@intentic/sandbox-contract/schemas/environment";
import { builtFromCheckout, rebuildPending, type SandboxBuild } from "@intentic/sandbox-contract/state/sandbox-build";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Services } from "../composition.js";
import type { Config } from "../env.config.js";
import { opt } from "../opt.js";
import { splitBlocks, uniqueBlocks, withoutRepeats } from "./overlay-blocks.js";
import { privacyPackFragments } from "./privacy-pack.js";
import { statePath } from "../state-paths.js";

// THE TWO BUILDS A SANDBOX HOLDS: the one it runs, read off what the runner stamped on its container (runningBuild), and
// the overlay it wants, composed from its inputs on every ask (composeEnvironment). Every comparison between them is the
// contract's (state/sandbox-build.ts); the proposals and approvals that feed the custom section are environment.ts's.

// The composed overlay, written where `ic` copies it from; and the owner-approved custom section, one of its inputs.
export const approvedPath = (services: Services): string => statePath(services.workspace.root, ".intentic/local/environment.approved.Dockerfile");
export const customPath = (services: Services): string => statePath(services.workspace.root, ".intentic/config/environment.custom.Dockerfile");

// Extends the image this sandbox is actually on, not a fixed tag, so a rebuild can't silently roll it back.
const RELEASE_IMAGE = "ghcr.io/intentic/sandbox:stable";

// Both inputs are runner-set, never agent-writable. `baseImage` wins since `runningImage` after a rebuild is the
// overlay's own tag, not a base; an unofficial ref is only honoured when the runner named it explicitly (the dev
// image).
export const baseImageOf = (baseImage: string | undefined, runningImage: string | undefined): string => {
    if (baseImage !== undefined && baseImage.trim() !== "") {
        return baseImage.trim();
    }
    const running = runningImage?.trim() ?? "";
    return isOfficialSandboxImage(running) ? running : RELEASE_IMAGE;
};

// The base named exactly: its reference with the registry digest the runner read (`ghcr.io/intentic/sandbox:stable@sha256:…`,
// which docker pulls by the digest and a reader still sees the channel in). For what a sandbox records about itself, a
// definition's `baseImage`; never what an overlay composes FROM, which follows the channel's tag. A reference that
// already names a digest, or a digest that is not one, leaves the reference as it is.
export const pinnedBase = (base: string, digest: string): string =>
    base.includes("@") || !/^sha256:[0-9a-f]{64}$/u.test(digest) ? base : `${base}@${digest}`;

// The build this container runs, as the runner stamped it on the container, none of it agent-writable: the one place a
// SandboxBuild is read off this sandbox, for the Environment card, runner parity and the needs alike.
export const runningBuild = ({ baseImage, image, baseDigest, environmentHash }: Config["sandbox"]): SandboxBuild => ({
    base: baseImage.trim() === "" ? image.trim() : baseImage.trim(),
    ...opt("baseDigest", baseDigest === "" ? undefined : baseDigest),
    ...opt("overlay", environmentHash === "" ? undefined : environmentHash),
});

// Composed overlay must extend the official sandbox image; the FROM line is pinned in composeEnvironment, and every
// executor (`ic`, the hosted rebuild) re-checks it via the contract's `hasOfficialBase`.

const HEADER =
    "# Composed by the intentic sandbox daemon: do not edit by hand.\n" +
    "# Capability fragments are daemon-owned; the custom section mirrors .intentic/config/environment.custom.Dockerfile.";
const CUSTOM_MARKER = "# ---- custom (owner-approved) ----";

// Writes a derived file only when its content actually changed; on a read-triggered recompose, an unconditional write
// would retrigger the workspace watcher into refetching the same query forever.
export const writeComposed = async (services: Services, path: string, content: string): Promise<void> => {
    if ((await services.files.read(path)) === content) {
        return;
    }
    await services.files.write(path, content);
};

// On a hosted VM, already root over the whole machine, `# intentic:runtime` lines (privileges for a docker-run
// executor) are meaningless; stripped here along with any fragment left with no real instruction after they're gone.
export const withoutRuntimeDirectives = (fragments: readonly string[]): string[] =>
    fragments
        .map((fragment) =>
            fragment
                .split("\n")
                .filter((line) => !line.trim().startsWith("# intentic:runtime"))
                .join("\n")
                .trim(),
        )
        .filter((fragment) => fragment.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#")));

// The sections a composed overlay carries, each by the hash of its trimmed steps: every capability fragment (unnamed) and
// every custom-section block (by its tool's name). What a composition record keeps, so "does the running build carry
// this block" is answered by content (carriedBy) rather than by which overlay was newest when something was approved.
const compositionBlocksOf = (fragments: readonly string[], content: string): { readonly name: string; readonly hash: string }[] => {
    const at = content.indexOf(CUSTOM_MARKER);
    const custom = at === -1 ? [] : uniqueBlocks(splitBlocks(content.slice(at + CUSTOM_MARKER.length).trim()));
    return [
        ...fragments.map((fragment) => ({ name: "", hash: sha256Hex(fragment.trim()) })),
        ...custom.map((block) => ({ name: block.name, hash: sha256Hex(block.body.trim()) })),
    ];
};

export interface ComposedOverlay {
    readonly content: string;
    readonly hash: string;
}

// Writes the composed overlay where `ic` copies it from (recreate.rs APPROVED_FILE) and keeps its composition record.
const materialize = async (services: Services, content: string, fragments: readonly string[]): Promise<ComposedOverlay> => {
    await writeComposed(services, approvedPath(services), content);
    const hash = sha256Hex(content);
    await services.runtimeInstalls.recordComposition({ hash, at: Date.now(), blocks: compositionBlocksOf(fragments, content) });
    return { content, hash };
};

const composeNow = async (services: Services): Promise<ComposedOverlay | undefined> => {
    const capabilities = await services.capabilities.list();
    const contributed = [
        ...new Set([
            ...(await Promise.all(capabilities.map((capability) => services.environmentSources.capabilityFragments(capability)))).flat(),
            ...(await services.environmentSources.workspaceExtensionFragments()),
            // Helper binaries a connected provider needs, for a base image that doesn't already bake them.
            ...(await services.environmentSources.providerPackFragments()),
            // The privacy shield's readers, while its policy asks for one.
            ...(await privacyPackFragments(services)),
        ]),
    ].toSorted();
    const fragments = services.config.sandbox.vm ? withoutRuntimeDirectives(contributed) : contributed;
    // Once per tool: a section an older release appended a repeat to builds that tool once, not once per copy.
    const custom = withoutRepeats(((await services.files.read(customPath(services))) ?? "").trim());
    // The base this container was built from, so a rebuild is version-preserving rather than a silent rollback.
    const base = baseImageOf(services.config.sandbox.baseImage, services.config.sandbox.image);
    if (fragments.length === 0 && custom === "") {
        if (runningBuild(services.config.sandbox).overlay === undefined) {
            await services.files.remove(approvedPath(services));
            return undefined;
        }
        // Built from an overlay now empty; keep a bare one so the owner has a hash-pinned path back to stock.
        return await materialize(services, `${HEADER}\n\nFROM ${base}\n`, []);
    }
    const sections = [HEADER, `FROM ${base}`, ...fragments, ...(custom === "" ? [] : [CUSTOM_MARKER, custom])];
    return await materialize(services, `${sections.join("\n\n")}\n`, fragments);
};

// THE OVERLAY THIS SANDBOX WANTS, composed from its inputs now: the base it runs, every capability's fragment and the
// owner-approved custom section; undefined when it wants none. Everything that asks "what would a rebuild build" (the
// Environment card, a capability's "rebuild needed", a runner's overlay) asks this, never the file it writes: that copy
// was the answer once, kept fresh by each writer remembering to recompose, and a land, a commit or a hand edit moved an
// input behind it; a rebuild baked the stale copy and the card read "pending rebuild" right after (2026-10-12, the
// second time). One compose at a time per file, so the last to write composed from the newest inputs.
export const composeEnvironment = async (services: Services): Promise<ComposedOverlay | undefined> =>
    await queueOnFile(approvedPath(services), () => composeNow(services));

// Whether the overlay this sandbox wants now is one it does not run: what a change to an input answers its caller with.
export const rebuildNeeded = async (services: Services): Promise<boolean> =>
    rebuildPending((await composeEnvironment(services))?.hash, runningBuild(services.config.sandbox).overlay);

// What the runner stamped on THIS container, none of it agent-writable: the overlay it was built from, the name a
// rebuild targets, and whether its base was compiled from a checkout rather than published. That last one is the
// dogfood shape, and it changes what the Environment card can offer: such a sandbox is rebuilt from its checkout, and
// an update would move it onto the published image rather than refresh it.
export const containerFacts = (sandbox: Config["sandbox"]): Pick<Environment, "appliedHash" | "container" | "localImage"> => {
    const build = runningBuild(sandbox);
    return {
        ...opt("appliedHash", build.overlay),
        ...opt("container", sandbox.name === "" ? undefined : sandbox.name),
        ...opt("localImage", builtFromCheckout(build) ? { base: build.base, ...opt("root", sandbox.devRoot) } : undefined),
    };
};

// The blocks the running build carries, by the hash of their steps (compositionBlocksOf), read from the record of the
// overlay it was built from: none on a stock image, unknown when that overlay's record is no longer kept.
export const carriedBy = async (services: Services): Promise<ReadonlySet<string> | undefined> => {
    const running = runningBuild(services.config.sandbox).overlay;
    if (running === undefined) {
        return new Set();
    }
    const built = (await services.runtimeInstalls.read()).compositions?.find((entry) => entry.hash === running);
    return built === undefined ? undefined : new Set(built.blocks.map((block) => block.hash));
};
