import { STATE_DIR } from "@intentic/constants";
import { batchMatters, gitMatters, iqMatters } from "./batch-relevance.js";

/* The daemon's own state churn must not reach the reactions that re-walk the tree or re-read git. */

// What the watcher actually delivered in a 20 s sample with seven sessions running: no code at all.
const DAEMON_CHURN = [
    `${STATE_DIR}/records/artifacts/browser/page-2026-10-08T20-41-12.png`,
    `${STATE_DIR}/local/privacy-log.json`,
    `${STATE_DIR}/local/.privacy-log.json.55.3275.tmp`,
    `${STATE_DIR}/records/extension-usage.json`,
];

test("a batch of the daemon's own state moves neither the index nor git", () => {
    expect(batchMatters(DAEMON_CHURN, iqMatters)).toBe(false);
    expect(batchMatters(DAEMON_CHURN, gitMatters)).toBe(false);
});

test("one source file in the batch is enough for both", () => {
    const batch = [...DAEMON_CHURN, "intentic/_sandbox/sandbox/src/main.ts"];
    expect(batchMatters(batch, iqMatters)).toBe(true);
    expect(batchMatters(batch, gitMatters)).toBe(true);
});

test("an empty batch names nothing, so it may hold anything", () => {
    expect(batchMatters([], iqMatters)).toBe(true);
    expect(batchMatters([], gitMatters)).toBe(true);
});

test("tracked config is both indexed and versioned", () => {
    expect(batchMatters([".intentic/config/settings.json"], iqMatters)).toBe(true);
    expect(batchMatters([".intentic/config/settings.json"], gitMatters)).toBe(true);
});

test("each reaction keeps its own rule: unversioned authored config is searchable but invisible to git", () => {
    // The staged docs are authored (searchable) but not versioned.
    const path = `${STATE_DIR}/config/docs/index.json`;
    expect(iqMatters(path)).toBe(true);
    expect(gitMatters(path)).toBe(false);
});
