import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFLOAD_REF_PREFIX, type OffloadFrame, type RunnerCommand } from "@intentic/sandbox-contract";
import { createRunnerCommands } from "../runners/runner-command.js";

// bin/offload-run end to end, against a stand-in daemon that answers the two /offload routes the way offload.routes.ts
// does and runs the line through the real runner side (runner-command.ts), fetching the snapshot straight from this
// repo's own git dir. What is proven: to its caller the command is the command itself (output, exit code, the files it
// changed, the report it wrote), and a runner that cannot take it sends the line back to run here.

const OFFLOAD_RUN = join(import.meta.dir, "../../bin/offload-run");
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repo = (): string => {
    const root = mkdtempSync(join(tmpdir(), "offload-run-repo-"));
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "config", "user.email", "t@example.com");
    git(root, "config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "committed\n");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "one");
    writeFileSync(join(root, "a.txt"), "edited here, not committed\n");
    return root;
};

const servers: Server[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) {
        server.close();
    }
});

// The daemon's two routes: `ready` decides the first, and the second relays runner-command's frames as SSE.
const daemon = async (root: string, ready: boolean): Promise<{ readonly port: number; readonly asked: RunnerCommand[] }> => {
    const runner = createRunnerCommands({ offloadRoot: mkdtempSync(join(tmpdir(), "offload-run-runner-")), gitUrl: () => root, gitEnv: process.env, queue: async (line) => line });
    const asked: RunnerCommand[] = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
            void (async () => {
                if (req.method === "GET" && req.url?.startsWith("/offload/runners/") === true) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify(ready ? { runner: "r1", name: "omen", ready } : { runner: "r1", name: "omen", ready, why: "omen is offline" }));
                    return;
                }
                const input = JSON.parse(body) as RunnerCommand;
                asked.push(input);
                res.writeHead(200, { "content-type": "text/event-stream" });
                for await (const frame of runner.run(input)) {
                    res.write(`event: message\ndata: ${JSON.stringify(frame satisfies OffloadFrame)}\n\n`);
                }
                res.end();
            })();
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, asked };
};

const offloadRun = (cwd: string, port: number, args: readonly string[], env: Record<string, string> = {}) =>
    new Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }>((resolve) => {
        const token = join(mkdtempSync(join(tmpdir(), "offload-run-token-")), "agent.token");
        writeFileSync(token, "test-token\n");
        const child = spawn(process.execPath.endsWith("bun") ? "node" : process.execPath, [OFFLOAD_RUN, ...args], {
            cwd,
            env: { ...process.env, SANDBOX_PORT: String(port), INTENTIC_AGENT_TOKEN_PATH: token, WORKSPACE_ROOT: cwd, ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

describe("offload-run", () => {
    test("is the command itself to its caller: output, exit code, the files it changed and the report it wrote", async () => {
        const root = repo();
        const { port, asked } = await daemon(root, true);
        const report = join(mkdtempSync(join(tmpdir(), "offload-run-report-")), "report.json");
        const ran = await offloadRun(
            root,
            port,
            ["--to", "r1", "--label", "bun-test", "--env", "GREETING", "--export", "REPORT", "--", "bash", "-c", 'cat a.txt; echo "$GREETING"; echo fixed > a.txt; echo \'{"failures":[]}\' > "$REPORT"; exit 4'],
            { GREETING: "hello from here", REPORT: report },
        );
        expect(ran.code).toBe(4);
        expect(ran.stdout).toBe("edited here, not committed\nhello from here\n");
        expect(ran.stderr).toContain("running on omen");
        expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("fixed\n");
        expect(readFileSync(report, "utf8")).toBe('{"failures":[]}\n');
        expect(asked[0]).toMatchObject({ repo: "root", cwd: "", label: "bun-test", env: { GREETING: "hello from here" }, exports: ["REPORT"] });
        // The snapshot's ref is gone once the run ends.
        expect(git(root, "for-each-ref", OFFLOAD_REF_PREFIX)).toBe("");
    });

    test("runs the line here, behind the queue it was handed, when the runner cannot take it", async () => {
        const root = repo();
        const { port, asked } = await daemon(root, false);
        const marker = join(root, "ran-here");
        const ran = await offloadRun(root, port, ["--to", "r1", "--here", `touch ${marker} && `, "--", "bash", "-c", "echo local; exit 3"]);
        expect(ran.code).toBe(3);
        expect(ran.stdout).toBe("local\n");
        expect(ran.stderr).toContain("omen is offline; running it here");
        expect(existsSync(marker)).toBe(true);
        expect(asked).toEqual([]);
    });
});
