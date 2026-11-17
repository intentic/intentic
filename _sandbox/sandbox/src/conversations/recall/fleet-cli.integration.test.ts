import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// The `agents` command's refusals as an agent reads them, before any daemon call: a lookup's mistake answered with that
// lookup's own entry, not the hundred-line page whose other verbs pushed it out of a capped tool result.
const AGENTS = join(packageRoot(import.meta.url), "bin", "agents");
const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [AGENTS, ...args], { encoding: "utf8", env: { ...process.env, SANDBOX_PORT: "1" } });
    return { code: result.status, out: `${result.stdout}${result.stderr}` };
};

const FIND_ENTRY = "  agents find '<text>' [--all] [--limit <n>] [--repo <name>] [--owner <who>] [--json]";

test("every `agents find` refusal prints find's own usage and none of the other verbs", () => {
    for (const [argv, reason] of [
        [["find"], "agents: find needs something to look for"],
        [["find", "--bogus", "x"], "agents: unknown flag --bogus"],
        [["find", "x", "--limit"], "agents: --limit needs a value"],
        [["find", "-x", "y"], 'agents: unknown flag -x; put a handle or text that starts with "-" after "--"'],
    ] as const) {
        const { code, out } = run(...argv);
        expect({ argv, code, first: out.split("\n")[0] }).toEqual({ argv, code: 1, first: reason });
        expect(out).toContain(FIND_ENTRY);
        expect(out).toContain("agents --help lists every verb.");
        expect(out).not.toContain("agents show <handle>");
        expect(out).not.toContain("agents spawn");
    }
});

test("`agents find --help` is find's usage and succeeds; the bare page still lists every verb", () => {
    const help = run("find", "--help");
    expect(help.code).toBe(0);
    expect(help.out.split("\n")[0]).toBe(FIND_ENTRY);
    expect(help.out).not.toContain("agents show <handle>");

    const page = run("--help");
    expect(page.code).toBe(0);
    expect(page.out).toContain(FIND_ENTRY);
    expect(page.out).toContain("agents show <handle>");
});

// Against a stub daemon that answers what the real routes would (fleet-reads.ts), so the command's own reading of the
// answers is what is tested: `self`, `--report` and a cut page. 2026-11-17, the shinobi-society audit.
describe("against a daemon", () => {
    const asked: string[] = [];
    let server: Server;
    let port = 0;
    let dir = "";
    // Asynchronously, since the stub answers from this same process: a synchronous spawn would wait on itself.
    const answers = {
        "/fleet/fair-sage-ey2r": { agent: { id: "fair-sage-ey2r", status: "idle" } },
        "/fleet": {
            agents: [{ id: "fair-sage-ey2r", status: "idle", provider: "claude", title: "One", updatedAt: Date.now(), turns: 1 }],
            total: 152,
            truncated: true,
            maxLimit: 100,
        },
    } as const;
    const report = `Done.\n${"x".repeat(30_000)}\nThe end.`;
    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "agents-cli-"));
        writeFileSync(join(dir, "token"), "t");
        server = createServer((request, response) => {
            const url = new URL(request.url ?? "/", "http://stub");
            asked.push(`${url.pathname}${url.search}`);
            const transcript =
                url.searchParams.get("raw") === "1"
                    ? {
                          transcript: {
                              total: 3,
                              rows: [
                                  { role: "user", text: "do it", at: 0 },
                                  { role: "assistant", text: report, at: 1, sentAt: 0 },
                                  { role: "assistant", text: "", at: 2 },
                              ],
                          },
                      }
                    : {};
            response.setHeader("content-type", "application/json");
            const known = url.pathname === "/fleet" || url.pathname === "/fleet/fair-sage-ey2r" ? answers[url.pathname] : {};
            response.end(JSON.stringify({ ...known, ...transcript }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        // SAFETY: a server listening on a TCP port answers address() with an AddressInfo, never a pipe's path.
        port = (server.address() as AddressInfo).port;
    });
    afterAll(() => {
        server.close();
        rmSync(dir, { recursive: true, force: true });
    });
    const against = (env: Record<string, string>, ...args: string[]) =>
        new Promise<{ code: number; out: string }>((resolve) => {
            execFile(
                process.execPath,
                [AGENTS, ...args],
                { encoding: "utf8", env: { ...process.env, INTENTIC_TURN_OWNER: "", ...env, SANDBOX_PORT: String(port), INTENTIC_AGENT_TOKEN_FILE: join(dir, "token") } },
                (error, stdout, stderr) => resolve({ code: error === null ? 0 : Number(error.code), out: `${stdout}${stderr}` }),
            );
        });

    test("`self` and `me` name the conversation this shell runs for", async () => {
        asked.length = 0;
        expect((await against({ INTENTIC_TURN_OWNER: "fair-sage-ey2r" }, "show", "self", "--json")).code).toBe(0);
        expect((await against({ INTENTIC_TURN_OWNER: "fair-sage-ey2r" }, "bundle", "me")).code).toBe(0);
        expect(asked.map((path) => path.split("?")[0])).toEqual(["/fleet/fair-sage-ey2r", "/fleet/fair-sage-ey2r/bundle"]);
        const none = await against({}, "show", "self");
        expect(none).toEqual({
            code: 1,
            out: "agents: `self` names the conversation this shell runs for, and this shell carries none (INTENTIC_TURN_OWNER is unset); name it by its id\n",
        });
    });

    test("`--report` prints the last reply with words in it, whole", async () => {
        const { code, out } = await against({}, "show", "fair-sage-ey2r", "--report");
        expect(code).toBe(0);
        expect(out).toBe(`report of fair-sage-ey2r (idle) · message #1 · sent 1970-01-01 00:00\n${report}\n`);
    });

    test("a cut page says how many there are and how to see more", async () => {
        const { out } = await against({}, "ls");
        expect(out).toContain("showing 1 of 152: agents ls --limit 100 for more, or narrow with --repo, --owner or `agents find`\n");
    });
});
