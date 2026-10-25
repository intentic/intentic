import { openCodeMounts } from "../opencode-mcp.js";
import { personaRules } from "./opencode-allowlist.js";
import { sessionRulesOf } from "./opencode-session-rules.js";

// What a persona withholds, as OpenCode session rules that come after everything else, so nothing before them hands it back.

test("a withheld tool's action is denied last, and a fence puts every read and edit through the ask that checks its path", () => {
    expect(personaRules(undefined)).toEqual([]);
    expect(personaRules({ deniedTools: ["Edit", "Write", "Bash", "BashOutput", "Skill(x)"] })).toEqual([
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
        // A withheld skill by its name, as OpenCode's skill action is asked.
        { action: "skill", resource: "x", effect: "deny" },
    ]);
    expect(personaRules({ deniedTools: ["Edit"], scope: { cwd: "/w", fence: ["notes"], sandbox: true } })).toEqual([
        { action: "edit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "ask" },
    ]);
});

test("the session's own rules come first and the persona's last", () => {
    const rules = sessionRulesOf({ persona: { deniedTools: ["WebFetch"] } }, openCodeMounts("chat-1", []));
    expect(rules.at(-1)).toEqual({ action: "webfetch", resource: "*", effect: "deny" });
    expect(sessionRulesOf({ sealed: true, persona: { deniedTools: ["WebFetch"] } }, openCodeMounts("chat-1", []))).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
});
