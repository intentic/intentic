import { searchNoticeHooks, walksTreeWithGrep } from "./agent-search.js";

// The predicate is judged on the miss, not the hit: a notice firing on a filtering grep teaches the agent to ignore the
// sentence.

test("a recursive grep reading the filesystem is what earns the notice", () => {
    for (const command of [
        `grep -rn "temporarily unavailable" --include=*.ts .`,
        `cd /work/intentic && grep -rn "trialUnavailable" _sandbox/sandbox/src`,
        `grep -R foo .`,
        `grep --recursive foo .`,
        // the wasteful idiom the corpus is full of: walk everything, then discard node_modules afterwards
        `cd /work/intentic && grep -rn "personaPrompt" --include=*.ts . | grep -v node_modules`,
    ]) {
        expect(walksTreeWithGrep(command), command).toBe(true);
    }
});

test("a grep that is filtering, not walking, is left alone", () => {
    for (const command of [
        // the right-hand side of a pipe is reading a command's output, whatever its flags
        `ps aux | grep -i node`,
        `cat /history/logs/daemon.log | grep -r trial`,
        `env | grep -i komodo`,
        `pnpm verify 2>&1 | grep -E "error TS[0-9]+" | head -40`,
        // no -r: reading one named file
        `grep -n "poster" src/listener.ts`,
        `grep -c "" /tmp/out.log`,
        // the word appears, but as a search term rather than as the command
        `rg -n "grep -rn" docs`,
        // the flag appears, but inside the pattern: this grep reads one named file and walks nothing
        `grep -n "foo -r bar" src/a.ts`,
        `grep -n 'usage: grep -R dir' README.md`,
    ]) {
        expect(walksTreeWithGrep(command), command).toBe(false);
    }
});

const bashCall = (command: string, response: string) =>
    ({ hook_event_name: "PostToolUse", tool_input: { command }, tool_response: { stdout: response, stderr: "" } }) as never;
const contextOf = (result: unknown): string | undefined =>
    (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;

// Once per turn is the whole economy here: a notice repeated many times in one turn is not amplified steering, it's the
// reason later ones go unread.
test("each notice is said once per turn, however many times it is earned", async () => {
    const { PostToolUse } = searchNoticeHooks();
    const fire = PostToolUse?.[0]?.hooks[0];
    if (fire === undefined) {
        throw new Error("expected a PostToolUse hook");
    }
    const first = await fire(bashCall(`grep -rn foo .`, "src/a.ts:1:foo"), undefined, { signal: new AbortController().signal });
    expect(contextOf(first)).toContain("ripgrep");
    const second = await fire(bashCall(`grep -rn bar .`, "src/b.ts:2:bar"), undefined, { signal: new AbortController().signal });
    expect(second).toEqual({});
});
