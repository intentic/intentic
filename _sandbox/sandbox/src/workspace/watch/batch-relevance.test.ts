import { STATE_DIR } from "@intentic/constants";
import { batchMatters, gitMatters } from "./batch-relevance.js";

/* The daemon's own state churn must not reach the reactions that re-read git. */

// What the watcher actually delivered in a 20 s sample with seven sessions running: no code at all.
const DAEMON_CHURN = [
    `${STATE_DIR}/records/artifacts/browser/page-2026-10-08T20-41-12.png`,
    `${STATE_DIR}/local/privacy-log.json`,
    `${STATE_DIR}/local/.privacy-log.json.55.3275.tmp`,
    `${STATE_DIR}/records/extension-usage.json`,
];

test("a batch of the daemon's own state does not move git", () => {
    expect(batchMatters(DAEMON_CHURN, gitMatters)).toBe(false);
});

test("one source file in the batch is enough", () => {
    expect(batchMatters([...DAEMON_CHURN, "intentic/_sandbox/sandbox/src/main.ts"], gitMatters)).toBe(true);
});

test("an empty batch names nothing, so it may hold anything", () => {
    expect(batchMatters([], gitMatters)).toBe(true);
});

test("tracked config is versioned, and unversioned authored config is invisible to git", () => {
    expect(batchMatters([".intentic/config/settings.json"], gitMatters)).toBe(true);
    // The staged docs are authored but not versioned.
    expect(gitMatters(`${STATE_DIR}/config/docs/index.json`)).toBe(false);
});
