import {
    commandSignature,
    commandWords,
    learnedCostBytes,
    lineWords,
    PEAK_MARGIN,
    peakWords,
    pricedWords,
    queuedCommand,
    startTicksOf,
} from "./command-peaks.mjs";
import { floorWords } from "./memory-floor.mjs";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const wordsOf = (line: string, root?: string): string | undefined => commandWords(lineWords(line), root);

// Lines agents ran in the shinobi-society sandbox, 2026-11-20..21: the test binary of the first two peaked at 7 to 13.5 GB.
test.each([
    ["cargo test -p integra-render --lib -- vfx_slots vfx_render", "cargo test --lib -p integra-render"],
    ["INTENTIC_OFFLOAD=0 cargo test --manifest-path integra/Cargo.toml -p integra-render --no-fail-fast", "cargo test -p integra-render"],
    ["cargo check --workspace --all-targets", "cargo check --all-targets --workspace"],
])("a cargo line is its subcommand and its sorted selectors: %s", (line, words) => {
    expect(wordsOf(line)).toBe(words);
});

test("filters, -j, env, timeout, redirections and pipes never make a cargo line another command", () => {
    const one = wordsOf("cargo test -p integra-render --lib -- vfx_slots");
    expect(one).toBe("cargo test --lib -p integra-render");
    for (const line of [
        "cargo test -p integra-render --lib -- vfx_render --nocapture",
        "cargo test -j 4 --lib -p integra-render vfx_slots",
        "RUST_BACKTRACE=1 timeout --kill-after=10 600 cargo test --package=integra-render --lib 2>&1 | tail -40",
        "env RUSTFLAGS=-Cdebuginfo=0 nice -n 10 cargo +nightly test -pintegra-render --lib > /tmp/out.log; echo done",
    ]) {
        expect(wordsOf(line)).toBe(one);
    }
});

test("what decides a cargo command's size makes it another command", () => {
    expect(wordsOf("cargo test -p integra-render --release")).toBe("cargo test --release -p integra-render");
    expect(wordsOf("cargo test -p integra-render --test golden")).toBe("cargo test --test golden -p integra-render");
    expect(wordsOf("cargo clippy --all --target x86_64-unknown-linux-gnu --features gpu")).toBe(
        "cargo clippy --features gpu --target x86_64-unknown-linux-gnu --workspace",
    );
});

test("the queue's own wrappers come off: queue-run as bash runs it, then heavy-launch.cjs", () => {
    const argv = [
        "/usr/bin/bash",
        "/usr/local/bin/queue-run",
        "--pool",
        "cargo",
        "--label",
        "cargo-verify",
        "--size",
        "targeted",
        "--",
        "/usr/bin/node",
        "/opt/sandbox/node_modules/@intentic/constants/src/heavy/heavy-launch.cjs",
        "--parallel",
        "cargo",
        "--label",
        "cargo-verify",
        "--",
        "/root/.cargo/bin/cargo",
        "check",
        "-p",
        "shinobi-society",
        "--tests",
    ];
    expect(queuedCommand(argv)).toEqual(argv.slice(9));
    expect(commandWords(argv)).toBe("cargo check --tests -p shinobi-society");
    expect(queuedCommand(["/usr/bin/bash", "/usr/local/bin/tmux-run", "--", "cargo", "test"])).toBeUndefined();
    expect(queuedCommand(["/usr/bin/bash", "/usr/local/bin/queue-run", "--pool", "cargo"])).toBeUndefined();
});

test("any other program is its words up to `--`, a path in the checkout made relative to it", () => {
    expect(wordsOf("pnpm --filter @intentic/sandbox test src/workload/room-socket -- --bail", "/work/intentic")).toBe("pnpm --filter @intentic/sandbox test src/workload/room-socket");
    expect(wordsOf("bun test /work/intentic/_tools/constants/src/a.test.ts 2>/dev/null", "/work/intentic")).toBe("bun test _tools/constants/src/a.test.ts");
    expect(wordsOf("FOO=1 >/dev/null")).toBeUndefined();
});

test("a line splits as a shell would: quotes kept together, operators apart, `2>&1` one word", () => {
    expect(lineWords(`cargo test -p 'a b' "c d"&&echo x 2>&1|tail`)).toEqual(["cargo", "test", "-p", "a b", "c d", "&&", "echo", "x", "2>&1", "|", "tail"]);
});

test("the key is the rule, the repository and the command's words", () => {
    expect(commandSignature({ rule: "cargo-verify", command: lineWords("cargo test -p integra-render --lib -- vfx") })).toEqual({
        key: "cargo-verify @: cargo test --lib -p integra-render",
        command: "cargo test --lib -p integra-render",
    });
});

test("a process's start is field 22 of its stat, past a command name that holds spaces and parentheses", () => {
    expect(startTicksOf("4242 (integra_render- (x)) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 987654 1000 10 18446744073709551615")).toBe(987_654);
    expect(startTicksOf("garbage")).toBeUndefined();
});

test("a command is priced at the larger of its rule's price and its peak with the margin, never past the sandbox's limit", () => {
    expect(PEAK_MARGIN).toBe(1.15);
    const targeted = 512 * MIB;
    // Never measured: the rule's price, exactly as before.
    expect(learnedCostBytes(targeted, undefined, 18 * GIB)).toBe(targeted);
    // Measured lighter than its rule says: the rule's price stands.
    expect(learnedCostBytes(7 * GIB, 3 * GIB, 18 * GIB)).toBe(7 * GIB);
    // Measured heavier: its peak, with the margin.
    expect(learnedCostBytes(targeted, 8 * GIB, 18 * GIB)).toBe(Math.ceil(8 * GIB * 1.15));
    // An outlier past what the sandbox could hold is held at its limit, where it waits like any large command.
    expect(learnedCostBytes(targeted, 16 * GIB, 18 * GIB)).toBe(18 * GIB);
    expect(learnedCostBytes(targeted, 16 * GIB, undefined)).toBe(Math.ceil(16 * GIB * 1.15));
    // A rule's own price above the limit is not cut by the cap, which is the learned price's alone.
    expect(learnedCostBytes(20 * GIB, 16 * GIB, 18 * GIB)).toBe(20 * GIB);
});

test("the wait line names the learned price and where it came from", () => {
    const priced = { bytes: 11.2 * GIB, peakBytes: 9.7 * GIB, runs: 1, command: "cargo test --lib -p integra-render" };
    expect(peakWords(priced)).toBe("`cargo test --lib -p integra-render` peaked at 9.7 GiB on its last run");
    expect(peakWords({ ...priced, runs: 3 })).toBe("`cargo test --lib -p integra-render` peaked at 9.7 GiB over its last 3 runs");
    expect(pricedWords(priced)).toBe(" Priced at 11.2 GiB: `cargo test --lib -p integra-render` peaked at 9.7 GiB on its last run.");
    expect(pricedWords(undefined)).toBe("");
    expect(floorWords("cargo-verify", { freeBytes: 0.5 * GIB, needBytes: 12.2 * GIB, priced }, { waitedMs: 0, ceilingMs: 60_000 })).toContain(
        "(it asks for 12.2 GiB, since `cargo test --lib -p integra-render` peaked at 9.7 GiB on its last run).",
    );
});
