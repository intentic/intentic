import { WEBEXT_PEER } from "../webext/webext-peer.js";
import { WEBEXT_CALL_TIMEOUT_MS, WEBEXT_CLIENT_TIMEOUT_MS } from "./webext-call-deadline.js";

// The extension's longest call, wait_for at its ceiling (_devices/webext/src/background/tools/page.ts MAX_WAIT_SECONDS),
// plus what it may take past that when the page froze in its last round and was still loading (page-wait.ts: 15 s
// grace, a 5 s probe, a 10 s load). Written out rather than imported: the extension is another package, shipped to a
// store at its own pace.
const LONGEST_WAIT_MS = 540_000 + 15_000 + 5_000 + 10_000;

// The deadlines nest: the wait inside the hub's, the hub's inside the agent's client. One cut shorter than the one inside
// it ends a call that would have answered, and the agent reads a transport error instead of the page.
test("a nine-minute wait_for fits inside the hub's deadline, and the hub's inside the agent's client", () => {
    expect(WEBEXT_PEER.hub.callTimeoutMs).toBe(WEBEXT_CALL_TIMEOUT_MS);
    // Half a minute at least for the page read after the wait and the trip back.
    expect(WEBEXT_CALL_TIMEOUT_MS - LONGEST_WAIT_MS).toBeGreaterThanOrEqual(30_000);
    expect(WEBEXT_CLIENT_TIMEOUT_MS).toBeGreaterThan(WEBEXT_CALL_TIMEOUT_MS);
});
