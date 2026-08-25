import { expect, test } from "vitest";
import { searchCameBackEmpty, searchNoticeHooks, walksTreeWithGrep } from "./agent-search.js";

/* WHAT THESE TWO PREDICATES HAVE TO GET RIGHT is not the hit, it is the MISS. A notice that fires on a grep
 * filtering a log, or on an empty result that only looked empty because the search was redirected to a file,
 * teaches the agent that these sentences are noise, and the next one it needs goes unread with them. So the
 * silent cases carry as much weight here as the loud ones. */

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
        // the word appears, but as a search TERM rather than as the command
        `rg -n "grep -rn" docs`,
        // the FLAG appears, but inside the pattern: this grep reads one named file and walks nothing
        `grep -n "foo -r bar" src/a.ts`,
        `grep -n 'usage: grep -R dir' README.md`,
    ]) {
        expect(walksTreeWithGrep(command), command).toBe(false);
    }
});

test("an empty ripgrep, and only a search that really did answer nothing", () => {
    expect(searchCameBackEmpty(`rg -n "nothingHere" .`, "")).toBe(true);
    expect(searchCameBackEmpty(`cd /work/intentic && rg -l "nothingHere"`, "")).toBe(true);
    expect(searchCameBackEmpty(`rg "nothingHere" | head -20`, "   \n  ")).toBe(true);
    // a hit is a hit
    expect(searchCameBackEmpty(`rg -n "found" .`, "src/a.ts:1:found")).toBe(false);
});

test("an empty stdout that is not an empty search stays quiet", () => {
    // redirected: the matches went to the file, not to the agent
    expect(searchCameBackEmpty(`rg -n "found" . > /tmp/hits.txt`, "")).toBe(false);
    // backgrounded: nothing has answered yet
    expect(searchCameBackEmpty(`rg -n "found" . &`, "")).toBe(false);
    // the empty belongs to some other command in the chain, not to the search
    expect(searchCameBackEmpty(`rg -n "found" . && mkdir -p /tmp/x`, "")).toBe(false);
    expect(searchCameBackEmpty(`mkdir -p /tmp/x`, "")).toBe(false);
    // grep's empty is not ripgrep's: this notice is about the tool that was actually reached for
    expect(searchCameBackEmpty(`grep -rn "nothingHere" .`, "")).toBe(false);
});

const bashCall = (command: string, response: string) =>
    ({ hook_event_name: "PostToolUse", tool_input: { command }, tool_response: { stdout: response, stderr: "" } }) as never;
const contextOf = (result: unknown): string | undefined =>
    (result as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;

/* ONCE PER TURN IS THE WHOLE ECONOMY OF THIS. 51.1% of corpus turns contain at least one repo-walking grep, a
 * median of 4 and a p90 of 15; capping at the first drops 8,236 firings to 1,275. A notice repeated fifteen
 * times in one turn is not fifteen times the steer, it is the reason the fifteenth goes unread. */
test("each notice is said once per turn, however many times it is earned", async () => {
    const { PostToolUse } = searchNoticeHooks(true);
    const fire = PostToolUse?.[0]?.hooks[0];
    if (fire === undefined) {
        throw new Error("expected a PostToolUse hook");
    }
    const first = await fire(bashCall(`grep -rn foo .`, "src/a.ts:1:foo"), undefined, { signal: new AbortController().signal });
    expect(contextOf(first)).toContain("ripgrep");
    const second = await fire(bashCall(`grep -rn bar .`, "src/b.ts:2:bar"), undefined, { signal: new AbortController().signal });
    expect(second).toEqual({});
});

test("iq is named on an empty search only where its plugin is actually loaded", async () => {
    const call = bashCall(`rg -n "nothingHere" .`, "");
    const on = searchNoticeHooks(true).PostToolUse?.[0]?.hooks[0];
    const off = searchNoticeHooks(false).PostToolUse?.[0]?.hooks[0];
    if (on === undefined || off === undefined) {
        throw new Error("expected a PostToolUse hook");
    }
    expect(contextOf(await on(call, undefined, { signal: new AbortController().signal }))).toContain("iq");
    // The setting defaults off and carries a holdout arm; a notice that named iq anyway would jump the gate and
    // put the tool in front of the control group that exists to run without it.
    expect(await off(call, undefined, { signal: new AbortController().signal })).toEqual({});
});

// The empty result is the ANSWER, and the notice has to say so rather than only offering the alternative:
// an agent told "try iq" and nothing else rephrases the same dead pattern first.
test("the empty-search notice keeps the negative signal, not just the escape hatch", async () => {
    const fire = searchNoticeHooks(true).PostToolUse?.[0]?.hooks[0];
    if (fire === undefined) {
        throw new Error("expected a PostToolUse hook");
    }
    const text = contextOf(await fire(bashCall(`rg -n "nothingHere" .`, ""), undefined, { signal: new AbortController().signal })) ?? "";
    expect(text).toContain("not in the tree");
    expect(text).toContain("do not keep");
});
