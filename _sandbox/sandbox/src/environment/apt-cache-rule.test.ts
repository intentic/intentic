// The mechanical revision of a block approved before the apt cache rule. Every case here is a shape a real overlay
// carried: the single-package install, the long package list with its comments, and the block whose ENV and rustup
// lines must come through untouched. What a revision changes is exactly the cache handling, and the owner is shown it
// as a replacement for their block, so a stray edit anywhere else would be approved unread.
import { cacheProblem, withAptCaches } from "./apt-cache-rule.js";

const MOUNTS =
    "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n";

it("mounts both caches on a single-package install and drops the lists deletion", () => {
    const body = `# ffmpeg — encoding screen recordings.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends ffmpeg \\
    && rm -rf /var/lib/apt/lists/*`;
    expect(withAptCaches(body)).toBe(`# ffmpeg — encoding screen recordings.
${MOUNTS}    apt-get update \\
    && apt-get install -y --no-install-recommends ffmpeg`);
});

it("keeps a package list, its comments, and every instruction around it exactly as written", () => {
    const body = `# The desktop app's native half.
#   • clang / lld / llvm — cargo-xwin's cross-link toolchain.
RUN apt-get update \\
    && apt-get install -y --no-install-recommends \\
        build-essential \\
        clang \\
    && rm -rf /var/lib/apt/lists/*

ENV RUSTUP_HOME=/usr/local/rustup
RUN curl -fsSL https://sh.rustup.rs \\
    | sh -s -- -y --no-modify-path --default-toolchain stable \\
    && rustc --version`;
    const revised = withAptCaches(body);
    expect(revised).toBe(`# The desktop app's native half.
#   • clang / lld / llvm — cargo-xwin's cross-link toolchain.
${MOUNTS}    apt-get update \\
    && apt-get install -y --no-install-recommends \\
        build-essential \\
        clang

ENV RUSTUP_HOME=/usr/local/rustup
RUN curl -fsSL https://sh.rustup.rs \\
    | sh -s -- -y --no-modify-path --default-toolchain stable \\
    && rustc --version`);
    expect(cacheProblem(revised ?? "")).toBeUndefined();
});

it("takes out a deletion and an apt-get clean that sit mid-chain on one line", () => {
    const body = "RUN apt-get update && apt-get install -y file && apt-get clean && rm -rf /var/lib/apt/lists/* && file --version";
    expect(withAptCaches(body)).toBe(`${MOUNTS}    apt-get update && apt-get install -y file && file --version`);
});

it("adds only the mount a RUN is missing", () => {
    const body = "RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    apt-get update && apt-get install -y gh";
    expect(withAptCaches(body)).toBe(
        "RUN --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \\\n    --mount=type=cache,target=/var/cache/apt,sharing=locked \\\n    apt-get update && apt-get install -y gh",
    );
});

it("leaves a block that already keeps the rule alone", () => {
    expect(withAptCaches(`${MOUNTS}    apt-get update && apt-get install -y gh`)).toBeUndefined();
    expect(withAptCaches("RUN cargo install --locked cargo-xwin")).toBeUndefined();
});

// The lists mount shadows whatever the image held, so an install without its own update could find no package lists.
it("leaves an install with no update of its own for a person, rather than guessing", () => {
    expect(withAptCaches("RUN apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*")).toBeUndefined();
});
