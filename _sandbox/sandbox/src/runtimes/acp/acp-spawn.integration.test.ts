import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProcess } from "../../platform/resources/process-scan.js";
import { OOM_SCORE } from "../../platform/resources/workload-class.js";
import { type AcpProcess, spawnAcpProcess } from "./acp-spawn.js";

/* An ACP agent is configured as a free-form command, and `npx some-acp-agent` is the usual one. The display's regex reads
   that as a package manager, which ranked the runtime with the builds, the first thing the OOM killer takes. Its class
   comes from the adapter that spawned it; the kernel's own file is the proof. */

// A class never lowers a score, so the runtime reads as the higher of its class and what this runner inherited.
const INHERITED = process.platform === "linux" ? Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()) : 0;
const describeLinux = process.platform === "linux" && INHERITED < OOM_SCORE.heavy ? describe : describe.skip;

let dir: string | undefined;
let agent: AcpProcess | undefined;

afterEach(() => {
    agent?.child.kill("SIGKILL");
    agent = undefined;
    if (dir !== undefined) {
        rmSync(dir, { recursive: true, force: true });
        dir = undefined;
    }
});

describeLinux("an ACP runtime's OOM rank", () => {
    test("an agent started via npx ranks as a turn's runtime, not as a build", () => {
        dir = mkdtempSync(join(tmpdir(), "acp-npx-"));
        // Stands in for npx, so the test neither reaches the registry nor depends on npm being installed.
        const npx = join(dir, "npx");
        writeFileSync(npx, "#!/bin/sh\nexec sleep 30\n");
        chmodSync(npx, 0o755);
        const command = `${npx} -y @zed-industries/codex-acp`;
        expect(classifyProcess(command)).toBe("toolchain");
        agent = spawnAcpProcess(command, {}, dir);
        const score = Number(readFileSync(`/proc/${String(agent.child.pid ?? 0)}/oom_score_adj`, "utf8").trim());
        expect(score).toBe(Math.max(INHERITED, OOM_SCORE.turn));
    });
});
