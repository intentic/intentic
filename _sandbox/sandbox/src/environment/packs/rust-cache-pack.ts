import { packFragment } from "../../image/packs.js";

// THE RUST COMPILER CACHE RIDES WITH RUST (2026-11-17, the shinobi-society audit). Every conversation builds in a checkout
// of its own, so without a shared compiler cache each first build compiled every dependency again; the environment skill
// asked each Rust recipe to carry sccache lines, and the recipe it taught shared one sccache server across mount
// namespaces, which builds into whichever checkout started it. The rust-cache pack (image-packs/rust-cache.Dockerfile)
// is composed instead, before the custom section, wherever the overlay installs a Rust toolchain: the recipe needs no
// cache lines, and the pack's next revision reaches every Rust sandbox with its next image. A recipe that sets its own
// RUSTC_WRAPPER keeps it: its ENV would override the pack's anyway, and installing sccache twice buys nothing.

// A step that installs or puts on PATH a Rust toolchain: rustup, Debian's cargo or rustc, a CARGO_HOME's bin directory.
const RUST_TOOLCHAIN = /\b(rustup|cargo|rustc)\b/u;
const OWN_WRAPPER = /\bRUSTC_WRAPPER\b/u;

const instructionLines = (steps: readonly string[]): string[] =>
    steps.flatMap((step) => step.split("\n")).filter((line) => !line.trim().startsWith("#"));

// Whether these overlay steps (capability fragments and the custom section) install Rust without a wrapper of their own;
// comments do not count, since recipes explain themselves in words like "cargo check".
export const rustCacheWanted = (steps: readonly string[]): boolean => {
    const lines = instructionLines(steps);
    return lines.some((line) => RUST_TOOLCHAIN.test(line)) && !lines.some((line) => OWN_WRAPPER.test(line));
};

// The pack's fragment when the steps want it and the base image does not already bake this version of it.
export const rustCachePackFragments = async (steps: readonly string[]): Promise<string[]> => {
    if (!rustCacheWanted(steps)) {
        return [];
    }
    const fragment = await packFragment("rust-cache");
    return fragment === undefined ? [] : [fragment];
};
