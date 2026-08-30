import { expect, test } from "vitest";
import type { PlannedItem } from "./adapter-shared.js";
import { parseJson5ish } from "./json5ish.js";
import { detectOpenclaw, planOpenclaw } from "./openclaw.js";

/* The OpenClaw adapter over a lived-in fixture home: the JSON5 config with the edits people actually make
 * (comments, trailing commas, an inline bot token), the relocatable workspace, the daily-diary memory shape,
 * and the structured cron store with all three schedule kinds. */

const CONFIG = `{
    // hand-edited, as real ones are
    agents: {
        defaults: {
            workspace: "~/.openclaw/workspace",
            model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.4"] },
            heartbeat: { every: "30m", target: "owner" },
        },
    },
    channels: {
        telegram: { enabled: true, botToken: "123:abc", dmPolicy: "pairing" },
        whatsapp: { enabled: true },
        discord: { enabled: false, botToken: "\${DISCORD_BOT_TOKEN}" },
    },
    mcp: {
        servers: {
            linear: { url: "sse+https://mcp.linear.app/sse", headers: { Authorization: "Bearer lin_x" } },
        },
    },
    env: { GITHUB_TOKEN: "ghp_abc", DEBUG_LEVEL: "3" },
    hooks: { enabled: true },
}`;

const JOBS = JSON.stringify({
    jobs: [
        {
            name: "Morning brief",
            schedule: { kind: "cron", expr: "0 7 * * *", tz: "America/Los_Angeles" },
            payload: { kind: "agentTurn", message: "Summarize overnight updates." },
        },
        { name: "Water check", schedule: { kind: "every", everyMs: 14_400_000 }, payload: { message: "Check the plants." } },
        { name: "One-off", schedule: { kind: "at", expr: "2026-01-01T00:00:00Z" }, payload: { message: "Happy new year." } },
        { name: "Odd interval", schedule: { kind: "every", everyMs: 5_400_000 }, payload: { message: "Every 90 minutes." } },
    ],
});

const fixture = (): Map<string, Buffer> =>
    new Map(
        Object.entries({
            "openclaw.json": CONFIG,
            ".env": "OPENCLAW_LOG_LEVEL=debug\nBRAVE_API_KEY=bk-1\n",
            "cron/jobs.json": JOBS,
            "agents/main/agent/auth-profiles.json": JSON.stringify({
                anthropic: { apiKey: "sk-ant-2" },
                openai: { access_token: "oa-t", refresh_token: "oa-r" },
            }),
            "workspace/SOUL.md": "Dry wit, no fluff.",
            "workspace/IDENTITY.md": "Name: Claw. Emoji: 🦞.",
            "workspace/AGENTS.md": "Never send email without confirming.",
            "workspace/USER.md": "Prefers short answers.",
            "workspace/MEMORY.md": "The house wifi is called Pretzel.",
            ...Object.fromEntries(
                Array.from({ length: 16 }, (_, index) => [
                    `workspace/memory/2026-07-${String(index + 1).padStart(2, "0")}.md`,
                    `Diary day ${index + 1}.`,
                ]),
            ),
            "workspace/HEARTBEAT.md": "Check the calendar. Water the plants reminder at 4pm.",
            "workspace/BOOTSTRAP.md": "One-time ritual text.",
            "workspace/BOOT.md": "On boot: check mail.",
            "workspace/skills/weather/SKILL.md": "---\ndescription: Forecasts.\n---\nUse wttr.in.",
            "skills/weather/SKILL.md": "---\ndescription: The managed copy, outranked.\n---\nOld body.",
            "skills/timers/SKILL.md": "---\ndescription: Timers.\n---\nSet timers.",
        }).map(([path, content]) => [path, Buffer.from(content)]),
    );

const byId = (planned: readonly PlannedItem[], id: string): PlannedItem | undefined => planned.find((entry) => entry.item.id === id);

test("the json5-ish reader takes comments, trailing commas, bare keys and single quotes, refusing politely past that", () => {
    expect(parseJson5ish(`{"a": 1}`)).toEqual({ a: 1 });
    expect(parseJson5ish(`{ /* block */ a: 'x//not-a-comment', "b": [1, 2,], flag: true, // line\n }`)).toEqual({
        a: "x//not-a-comment",
        b: [1, 2],
        flag: true,
    });
    expect(parseJson5ish(`{"url": "https://example.com/path"}`)).toEqual({ url: "https://example.com/path" });
    expect(parseJson5ish(`not json at all`)).toBeUndefined();
});

test("detect answers for an openclaw home and stays quiet elsewhere", () => {
    expect(detectOpenclaw(fixture())).toBe(true);
    expect(detectOpenclaw(new Map([["openclaw.json", Buffer.from("{}")]]))).toBe(false);
    expect(detectOpenclaw(new Map([["config.yaml", Buffer.from("x: 1")]]))).toBe(false);
});

test("memory: four bootstrap fences, a curated block with the newest 14 diary days, the whole diary as files", () => {
    const { planned } = planOpenclaw(fixture());
    expect(byId(planned, "memory:soul")?.apply).toMatchObject({ target: "memory", fence: "intentic:imported-openclaw:soul" });
    expect(planned.map((entry) => entry.item.id)).toContain("memory:identity");
    expect(planned.map((entry) => entry.item.id)).toContain("memory:agents");
    const memories = byId(planned, "memory:memories");
    const body = memories?.apply.target === "memory" ? memories.apply.body : "";
    expect(body).toContain("Pretzel");
    // 16 diary days: the curated block carries the newest 14, so day 2 is in and day 1 and 2 are the cut:
    // day 3..16 are in, day 1 and 2 are not.
    expect(body).toContain("2026-07-16");
    expect(body).toContain("2026-07-03");
    expect(body).not.toContain("2026-07-02.md");
    const diary = byId(planned, "file:memory-diary");
    expect(diary?.apply.target === "file" ? diary.apply.files.length : 0).toBe(16);
    expect(diary?.apply.target === "file" ? diary.apply.files[0]?.relPath : "").toBe("imports/openclaw/memory/2026-07-01.md");
});

test("skills: the workspace copy outranks the managed one, which is refused by name", () => {
    const { planned, refused } = planOpenclaw(fixture());
    const weather = byId(planned, "skill:weather");
    expect(weather?.apply.target === "skill" ? weather.apply.skill.body : "").toContain("wttr.in");
    expect(planned.map((entry) => entry.item.id)).toContain("skill:timers");
    expect(refused.some((line) => line.includes("skills/weather/SKILL.md") && line.includes("higher-precedence"))).toBe(true);
});

test("secrets: .env, the config env section, inline channel tokens and auth-profile keys: pointers skipped", () => {
    const { planned, refused } = planOpenclaw(fixture());
    expect(byId(planned, "secret:BRAVE_API_KEY")?.item.recommended).toBe(true);
    expect(byId(planned, "secret:GITHUB_TOKEN")?.item.recommended).toBe(true);
    expect(byId(planned, "secret:DEBUG_LEVEL")?.item.recommended).toBe(false);
    expect(byId(planned, "secret:TELEGRAM_BOT_TOKEN")?.apply).toMatchObject({ target: "secret", value: "123:abc" });
    // Discord's token is a ${VAR} pointer: nothing to move.
    expect(byId(planned, "secret:DISCORD_BOT_TOKEN")).toBeUndefined();
    expect(byId(planned, "secret:ANTHROPIC_API_KEY")?.apply).toMatchObject({ target: "secret", value: "sk-ant-2" });
    expect(refused.some((line) => line.includes("openai OAuth"))).toBe(true);
});

test("the noise prefix demotes the tick without hiding the key: every env-shaped key is offered", () => {
    const { planned } = planOpenclaw(fixture());
    expect(byId(planned, "secret:OPENCLAW_LOG_LEVEL")?.item.recommended).toBe(false);
});

test("cron: expr jobs land, clean intervals convert, one-offs and unspellable intervals are refused by name", () => {
    const { planned, refused, needsAction } = planOpenclaw(fixture());
    const brief = byId(planned, "automation:openclaw-Morning-brief");
    expect(brief?.apply).toMatchObject({
        target: "automation",
        automation: { trigger: { kind: "schedule", cron: "0 7 * * *" }, requireApproval: true },
    });
    expect(byId(planned, "automation:openclaw-Water-check")?.apply).toMatchObject({
        target: "automation",
        automation: { trigger: { kind: "schedule", cron: "0 */4 * * *" } },
    });
    expect(refused.some((line) => line.includes("One-off") && line.includes("one-time"))).toBe(true);
    expect(refused.some((line) => line.includes("Odd interval") && line.includes("no clean cron"))).toBe(true);
    expect(needsAction.some((entry) => entry.subject === "Check automation hours" && entry.detail.includes("America/Los_Angeles"))).toBe(true);
});

test("the heartbeat file becomes a scheduled automation on the configured interval", () => {
    const { planned } = planOpenclaw(fixture());
    const heartbeat = byId(planned, "automation:openclaw-heartbeat");
    expect(heartbeat?.apply).toMatchObject({
        target: "automation",
        automation: { trigger: { kind: "schedule", cron: "*/30 * * * *" } },
    });
    expect(heartbeat?.apply.target === "automation" ? heartbeat.apply.automation.prompt : "").toContain("Water the plants");
});

test("mcp servers become capabilities; loose notes ride to imports/; the bootstrap ritual does not", () => {
    const { planned } = planOpenclaw(fixture());
    expect(byId(planned, "capability:mcp:linear")?.apply).toMatchObject({
        target: "capability",
        capability: { kind: "mcp", config: { url: "https://mcp.linear.app/sse", token: "lin_x" } },
    });
    expect(planned.map((entry) => entry.item.id)).toContain("file:BOOT.md");
    expect(byId(planned, "file:BOOTSTRAP.md")).toBeUndefined();
});

test("the known-not-to-move list: channels (whatsapp worded for its ratchet), the model, hooks, fallbacks", () => {
    const { needsAction, refused } = planOpenclaw(fixture());
    expect(needsAction.find((entry) => entry.subject === "Reconnect telegram")?.detail).toContain("TELEGRAM_BOT_TOKEN");
    expect(needsAction.find((entry) => entry.subject === "Reconnect whatsapp")?.detail).toContain("desynchronizes");
    expect(needsAction.some((entry) => entry.subject === "Reconnect discord")).toBe(false);
    expect(needsAction.find((entry) => entry.subject === "Pick your model provider")?.detail).toContain("Claude");
    expect(refused.some((line) => line.includes("hooks"))).toBe(true);
    expect(refused.some((line) => line.includes("fallbacks"))).toBe(true);
});

test("a home missing its workspace tells the owner to pack it rather than importing a hollow setup", () => {
    const files = new Map([...fixture()].filter(([path]) => !path.startsWith("workspace/")));
    const { planned, needsAction } = planOpenclaw(files);
    expect(planned.some((entry) => entry.item.id.startsWith("memory:"))).toBe(false);
    expect(needsAction.find((entry) => entry.subject === "Pack your workspace too")?.detail).toContain("~/.openclaw/workspace");
});

test("ids are deterministic across two derivations", () => {
    const first = planOpenclaw(fixture());
    const second = planOpenclaw(fixture());
    expect(second.planned.map((entry) => entry.item.id)).toEqual(first.planned.map((entry) => entry.item.id));
});
