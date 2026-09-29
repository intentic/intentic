import { NATIVE_PROVIDERS, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { AttemptRefused } from "../conversations/fix/fix-attempts.js";
import { infraLog, startCiFix } from "./ci-fix.js";
import type { CiProject } from "./projects.js";

// A failure read as the fleet's is re-run instead of fixed, so a test's own output must never read as the runner dying.

test("the runner's own death reads as the fleet, and a failing test's words never do", () => {
    expect(infraLog("ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")).toBe(true);
    expect(infraLog("write /tmp/x: no space left on device")).toBe(true);
    expect(infraLog("Put https://ghcr.io/v2/x/blobs/uploads: net/http: timeout awaiting response headers")).toBe(true);
    expect(infraLog("The self-hosted runner: worker-3 lost communication with the server.")).toBe(true);
    expect(infraLog("FAIL src/api.test.ts > retries\n  Error: connect ECONNREFUSED 127.0.0.1:4317")).toBe(false);
    expect(infraLog("expected status 200, received 503 Service Unavailable")).toBe(false);
});

// Nothing connected and nothing pinned: the fix is refused in words before any agent exists, rather than opened on a
// provider nobody connected to fail at once on the board. `agents` is left unstubbed, so reaching it would throw.
test("a fix with no provider connected is refused before an agent is created", async () => {
    const services = unstubbed<Services>("services", {
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        providerReadiness: async () => Object.fromEntries(NATIVE_PROVIDERS.map((provider) => [provider, false])) as Awaited<ReturnType<Services["providerReadiness"]>>,
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
    });
    const project = unstubbed<CiProject>("project", { repo: "odysseus" });
    const request = { project, runId: 7, run: undefined, evidence: { failedJobs: ["test"], logs: "", infra: false, infraSteps: [] } };
    await expect(startCiFix(services, request)).rejects.toThrow(AttemptRefused);
    await expect(startCiFix(services, request)).rejects.toThrow(
        "No AI provider is connected to this sandbox, so there is no model to run this on. Connect one in Setup, then try again.",
    );
});
