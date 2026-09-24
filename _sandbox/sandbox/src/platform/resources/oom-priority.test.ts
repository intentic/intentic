import { choomPrefix, OOM_SCORE, oomScoreOf, oomScoreResolver, raisedScore } from "./oom-priority.js";

// The order is the contract: what the kernel takes first when the sandbox runs out, read off the scores it is handed.

test("a turn's runtime, its children and its grandchildren each rank one level more killable", () => {
    expect(oomScoreOf("agentRuntime", 0)).toBe(OOM_SCORE.turn);
    expect(oomScoreOf("agentRuntime", 1)).toBe(OOM_SCORE.turn + OOM_SCORE.perSpawnLevel);
    expect(oomScoreOf("agentRuntime", 2)).toBe(OOM_SCORE.turn + 2 * OOM_SCORE.perSpawnLevel);
});

test("however deep a spawn goes, its runtime stays below a restartable service", () => {
    const deepest = OOM_SCORE.service - OOM_SCORE.perSpawnLevel;
    expect(oomScoreOf("agentRuntime", 3)).toBe(deepest);
    expect(oomScoreOf("agentRuntime", 10)).toBe(deepest);
});

test("builds go first, then agent commands, then services, then any agent, and the daemon's peers never", () => {
    expect(oomScoreOf("toolchain", 0)).toBe(OOM_SCORE.heavy);
    for (const role of ["searchEngine", "languageServer", "translator", "extension", "localModel", "browser"] as const) {
        expect(oomScoreOf(role, 0)).toBe(OOM_SCORE.service);
    }
    for (const role of ["git", "terminal", "container", "other"] as const) {
        expect(oomScoreOf(role, 0)).toBeUndefined();
    }
    expect([OOM_SCORE.heavy, OOM_SCORE.command, OOM_SCORE.service, OOM_SCORE.turn].toSorted((a, b) => b - a)).toEqual([
        OOM_SCORE.heavy,
        OOM_SCORE.command,
        OOM_SCORE.service,
        OOM_SCORE.turn,
    ]);
});

test("a score is only ever raised, so a process that ranked itself higher keeps its own", () => {
    expect(raisedScore(0, 300)).toBe(300);
    expect(raisedScore(300, 300)).toBeUndefined();
    expect(raisedScore(700, 300)).toBeUndefined();
});

test("the resolver reads the runtime from its command line and its depth from the conversation that owns it", () => {
    const resolve = oomScoreResolver((owner) => (owner === "sub-child" ? 1 : 0));
    const claude = "claude /history/engines/claude/versions/0.3.281/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude --output-format stream-json";
    expect(resolve({ command: claude, owner: "sub-child" })).toBe(OOM_SCORE.turn + OOM_SCORE.perSpawnLevel);
    expect(resolve({ command: claude, owner: "plain-harbor-k3bw" })).toBe(OOM_SCORE.turn);
    expect(resolve({ command: claude, owner: undefined })).toBe(OOM_SCORE.turn);
    expect(resolve({ command: "git git status --porcelain", owner: "plain-harbor-k3bw" })).toBeUndefined();
});

test("the command prefix hands choom the score and ends its own options", () => {
    expect(choomPrefix(OOM_SCORE.command)).toBe(`choom -n ${String(OOM_SCORE.command)} -- `);
});
