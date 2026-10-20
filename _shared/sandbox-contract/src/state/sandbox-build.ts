import { DEV_SANDBOX_IMAGE } from "../policy/overlay-lint.js";

// WHICH BUILD A SANDBOX IS, as one record, and every comparison made between two of them. A build is the base image it
// sits on and the environment overlay built on that base, each by content: the base by its registry digest when the
// runner read one, the overlay by the hash of the recipe built. A sandbox holds two at any moment, the build it runs
// (stamped on its container) and the overlay it wants (composed from its approvals now); a parent and its runner hold
// one each. "Rebuild pending" and runner parity are asked here and nowhere else. Each fix that once picked its own field
// (an image tag for parity, a cached file for pending) stayed local while the next surface kept its own (2026-10).

export interface SandboxBuild {
    // The base image as the runner named it (SANDBOX_BASE_IMAGE, else the image itself); empty when no runner said.
    readonly base: string;
    // The base's registry digest (`sha256:…`) when the runner could read one: what makes `base` one exact image.
    readonly baseDigest?: string | undefined;
    // sha256 of the environment overlay built on the base; absent on a stock image.
    readonly overlay?: string | undefined;
}

// Built on a base compiled from a checkout, which names whatever that machine's checkout held when it was built: it is
// compared with nothing, and a newer build of it comes from the checkout rather than the registry.
export const builtFromCheckout = (build: Pick<SandboxBuild, "base">): boolean => build.base === DEV_SANDBOX_IMAGE;

// The overlay a sandbox wants is not the one it runs. Wanting none is nothing to rebuild; a container built with an
// overlay whose every input has since gone still wants the bare one composed for it, which has a hash of its own.
export const rebuildPending = (desired: string | undefined, running: string | undefined): boolean => desired !== undefined && desired !== (running ?? "");

// Whether two sandboxes run the same code and environment: the base by digest when both sides read one (one tag pulled
// on two machines at two moments is two builds), else by its reference, and the overlay by hash, none on both sides
// agreeing. Unknown when either side named no base or was built from a checkout: nothing an update could bring level.
export const buildParity = (parent: SandboxBuild, other: SandboxBuild | undefined): "current" | "outdated" | "unknown" => {
    if (other === undefined || parent.base === "" || other.base === "" || builtFromCheckout(parent) || builtFromCheckout(other)) {
        return "unknown";
    }
    const sameBase =
        parent.baseDigest !== undefined && other.baseDigest !== undefined ? parent.baseDigest === other.baseDigest : parent.base === other.base;
    return sameBase && (parent.overlay ?? "") === (other.overlay ?? "") ? "current" : "outdated";
};
