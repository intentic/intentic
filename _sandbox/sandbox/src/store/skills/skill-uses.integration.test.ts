import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSkillLoads, readSkillUses, recordSkillUses, skillsLoadedBy, skillUsesDocument } from "./skill-uses.js";

const DAY_MS = 24 * 3_600_000;

test("a week counts only the turns inside it, and the last use outlives the window", async () => {
    const history = mkdtempSync(join(tmpdir(), "skill-uses-"));
    const now = Date.parse("2026-11-23T12:00:00Z");
    await recordSkillUses(history, ["review"], now - 9 * DAY_MS);
    await recordSkillUses(history, ["review", "review", "lsp"], now - DAY_MS);
    await recordSkillUses(history, ["review"], now);

    // Read from the file alone, as a restarted daemon would.
    const uses = await readSkillUses(history, now);
    expect(uses.get("review")).toEqual({ week: 2, last: new Date(now).toISOString() });
    expect(uses.get("lsp")).toEqual({ week: 1, last: new Date(now - DAY_MS).toISOString() });
    expect((await readSkillUses(history, now + 8 * DAY_MS)).get("lsp")).toEqual({ week: 0, last: new Date(now - DAY_MS).toISOString() });

    // Pruned on write: the instant nine days back is gone from the file, not merely skipped on read.
    const stored: unknown = JSON.parse(await readFile(join(history, skillUsesDocument.path), "utf8"));
    expect(stored).toMatchObject({ review: { recent: [now - DAY_MS, now] } });
});

test("a skill is loaded by its tool or by reading its file, and by nothing that only touches the file", () => {
    const call = { name: "Read", category: "read" } as const;
    expect(skillsLoadedBy({ name: "Skill", category: "other", input: '{"skill":"webq:webq","args":"x"}' })).toEqual(["webq"]);
    // OpenCode's skill tool takes `name`.
    expect(skillsLoadedBy({ name: "Skill", category: "other", input: '{"name":"review"}' })).toEqual(["review"]);
    expect(skillsLoadedBy({ ...call, target: "/root/.claude/skills/fileq/SKILL.md" })).toEqual(["fileq"]);
    expect(skillsLoadedBy({ ...call, locations: [{ path: ".agents/skills/lsp/SKILL.md" }] })).toEqual(["lsp"]);
    expect(skillsLoadedBy({ name: "Bash", category: "execute", target: "cd /work && cat .agents/skills/lsp/SKILL.md" })).toEqual(["lsp"]);
    expect(skillsLoadedBy({ name: "Bash", category: "execute", target: "rm .agents/skills/lsp/SKILL.md" })).toEqual([]);
    expect(skillsLoadedBy({ ...call, target: "src/myskills/lsp/SKILL.md" })).toEqual([]);
    expect(skillsLoadedBy({ ...call, target: ".agents/skills/lsp/README.md" })).toEqual([]);
    expect(skillsLoadedBy({ name: "Grep", category: "search", target: ".agents/skills/lsp/SKILL.md" })).toEqual([]);
});

test("a call whose input comes only on its update is read then, and the turn names each skill once", () => {
    const loads = createSkillLoads();
    loads.note({ kind: "tool_call", id: "a", name: "Read", category: "read", status: "pending" });
    loads.note({ kind: "tool_call_update", id: "a", input: '{"path":"/tmp/ws/.agents/skills/review/SKILL.md"}' });
    loads.note({ kind: "tool_call", id: "b", name: "Skill", category: "other", status: "pending", input: '{"skill":"review"}' });
    // An update for a call the fold never saw open names nothing.
    loads.note({ kind: "tool_call_update", id: "ghost", input: '{"path":".agents/skills/lsp/SKILL.md"}' });
    expect(loads.reading()).toEqual(["review"]);
});
