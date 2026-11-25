import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { classifyProcess } from "../../system/resources/process-scan.js";
import { OOM_SCORE } from "../../workload/workload-class.js";
import { waitFor } from "@intentic/testing/bun";
import { type AcpProcess, spawnAcpProcess, splitCommand, stopAcpProcess } from "./acp-spawn.js";

/* An ACP agent is configured as a free-form command, and `npx some-acp-agent` is the usual one. The display's regex reads
   that as a package manager, which ranked the runtime with the builds, the first thing the OOM killer takes. Its class
   comes from the adapter that spawned it; the kernel's own file is the proof. */

// A class never lowers a score, so the runtime reads as the higher of its class and what this runner inherited.
const INHERITED = process.platform === "linux" ? Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()) : 0;
// Only a rank above what this process inherited can be seen to land, and procfs is Linux's.
const kernel = requires(
    process.platform === "linux" && INHERITED < OOM_SCORE.heavy,
    `Linux, with this process ranked below the toolchain class (it inherited oom_score_adj ${String(INHERITED)})`,
);

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

describe.skipIf(!kernel.runs)(kernel.title("an ACP runtime's OOM rank"), () => {
    test("an agent started via npx ranks as a turn's runtime, not as a build", () => {
        dir = mkdtempSync(join(tmpdir(), "acp-npx-"));
        // Stands in for npx, so the test neither reaches the registry nor depends on npm being installed.
        const npx = join(dir, "npx");
        writeFileSync(npx, "#!/bin/sh\nexec sleep 30\n");
        chmodSync(npx, 0o755);
        const command = `${npx} -y @zed-industries/codex-acp`;
        expect(classifyProcess(command)).toBe("toolchain");
        agent = spawnAcpProcess({ argv: splitCommand(command), env: {} }, dir);
        const score = Number(readFileSync(`/proc/${String(agent.child.pid ?? 0)}/oom_score_adj`, "utf8").trim());
        expect(score).toBe(Math.max(INHERITED, OOM_SCORE.turn));
    });
});

/* An ACP agent is often a wrapper (`npx some-agent`) whose real agent, and the MCP servers that agent starts, are its
   children. Signalling the wrapper alone left them running (2026-11-24); the agent now leads a process group of its own,
   and stopping it ends the group. */

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

// A wrapper standing in for npx: it starts a grandchild, writes its pid where the test reads it, and waits.
const wrapperAgent = (prelude: string) => {
    dir = mkdtempSync(join(tmpdir(), "acp-tree-"));
    const pidFile = join(dir, "grandchild");
    const command = join(dir, "agent");
    writeFileSync(command, `#!/bin/sh\n${prelude}\nsleep 60 &\necho $! > ${pidFile}\nwait\n`);
    chmodSync(command, 0o755);
    return { command, pidFile };
};

describe.skipIf(process.platform !== "linux")("stopping an ACP agent", () => {
    test.each([
        ["a wrapper's grandchild ends with it", "true", undefined],
        // `trap "" TERM` is inherited by the grandchild too, so only the SIGKILL that follows the grace ends either.
        ["a tree that ignores SIGTERM is killed once the grace is up", `trap "" TERM`, 200],
    ] as const)("%s", async (_title, prelude, graceMs) => {
        const { command, pidFile } = wrapperAgent(prelude);
        const started = spawnAcpProcess({ argv: [command], env: {} }, dir ?? tmpdir());
        agent = started;
        const pid = await waitFor(() => {
            expect(existsSync(pidFile)).toBe(true);
            return Number(readFileSync(pidFile, "utf8").trim());
        }, { timeout: 3_000 });
        const closed = once(started.child, "close");
        stopAcpProcess(started, graceMs);
        await closed;
        await waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3_000 });
    });
});
