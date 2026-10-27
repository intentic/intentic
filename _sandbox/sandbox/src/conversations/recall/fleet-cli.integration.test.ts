import { spawnSync } from "node:child_process";
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
