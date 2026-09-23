import { expect, test } from "bun:test";
import { infraLog } from "./ci-fix.js";

// A red read as the fleet's is re-run instead of fixed, so a test's own output must never read as the runner dying.

test("the runner's own death reads as the fleet, and a failing test's words never do", () => {
    expect(infraLog("ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")).toBe(true);
    expect(infraLog("write /tmp/x: no space left on device")).toBe(true);
    expect(infraLog("Put https://ghcr.io/v2/x/blobs/uploads: net/http: timeout awaiting response headers")).toBe(true);
    expect(infraLog("The self-hosted runner: worker-3 lost communication with the server.")).toBe(true);
    expect(infraLog("FAIL src/api.test.ts > retries\n  Error: connect ECONNREFUSED 127.0.0.1:4317")).toBe(false);
    expect(infraLog("expected status 200, received 503 Service Unavailable")).toBe(false);
});
