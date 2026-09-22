import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type BackgroundJob, noteJobShell, openBackgroundJob } from "../tools/background-jobs.js";
import { openSpawnedChild, resetSubagents, settleSpawnedChild } from "./subagents.js";
import { waitForWork } from "./work-wait.js";

// A background command is waitable work, not an unknown target.

const dirs: string[] = [];
beforeEach(() => resetSubagents());
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const job = (conversationId: string, toolUseId: string, shellId: string): BackgroundJob => {
    const opened = openBackgroundJob({ conversationId, turn: {} }, { command: "pnpm build", session: `agent-${conversationId}`, toolUseId });
    if (opened === undefined) {
        throw new Error("the job dir could not be minted");
    }
    dirs.push(opened.dir);
    noteJobShell(toolUseId, shellId);
    return opened;
};

const finish = (target: BackgroundJob, code: string, output: string): void => {
    writeFileSync(join(target.dir, "out"), output);
    writeFileSync(join(target.dir, "status"), `${code}\n`);
};

describe("waitForWork", () => {
    it("parks on a background command named by the id its Bash call returned, and answers with how it ended", async () => {
        const build = job("conv-w1", "tu-w1", "bsh-w1");
        const wait = waitForWork("conv-w1", { target: "bsh-w1", until: ["blocked", "finished"], timeoutMs: 5_000 });
        finish(build, "1", "error TS2345\n");
        expect(await wait).toMatchObject({ outcome: "finished", job: { id: "bsh-w1", exitCode: 1, running: false, outputTail: "error TS2345\n" } });
    });

    it("answers a timeout with the command's state so far", async () => {
        const build = job("conv-w2", "tu-w2", "bsh-w2");
        writeFileSync(join(build.dir, "out"), "compiling…\n");
        expect(await waitForWork("conv-w2", { target: "bsh-w2", until: ["finished"], timeoutMs: 20 })).toMatchObject({
            outcome: "timeout",
            job: { id: "bsh-w2", running: true, outputTail: "compiling…\n" },
        });
    });

    it("with no target, a command finishing ends the wait even with no child to wait on", async () => {
        const build = job("conv-w3", "tu-w3", "bsh-w3");
        const wait = waitForWork("conv-w3", { until: ["blocked", "finished"], timeoutMs: 5_000 });
        finish(build, "0", "built\n");
        expect(await wait).toMatchObject({ outcome: "finished", job: { id: "bsh-w3", exitCode: 0 } });
    });

    it("with no target, a child moving first ends the wait, not the command still running", async () => {
        job("conv-w4", "tu-w4", "bsh-w4");
        openSpawnedChild(
            { conversationId: "conv-w4", cwd: WORKSPACE_ROOT, sessionId: undefined, subagentsDir: undefined },
            { id: "sub-w4", description: "port it" },
        );
        const wait = waitForWork("conv-w4", { until: ["finished"], timeoutMs: 5_000 });
        settleSpawnedChild("sub-w4", { failed: false, report: "ported" });
        expect(await wait).toMatchObject({ outcome: "finished", agent: { id: "sub-w4" } });
    });

    it("never parks on another conversation's command", async () => {
        job("conv-w5-other", "tu-w5", "bsh-w5");
        expect(await waitForWork("conv-w5", { target: "bsh-w5", until: ["finished"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "unknown-target",
        });
    });

    it("the turn's abort settles a wait on a command", async () => {
        job("conv-w6", "tu-w6", "bsh-w6");
        const controller = new AbortController();
        const wait = waitForWork("conv-w6", { target: "bsh-w6", until: ["finished"], timeoutMs: 5_000, signal: controller.signal });
        controller.abort();
        expect(await wait).toMatchObject({ outcome: "aborted" });
    });
});
