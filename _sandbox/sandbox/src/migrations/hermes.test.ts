import { expect, test } from "vitest";
import { detectHermes, planHermes, type PlannedItem } from "./hermes.js";

/* The adapter over a lived-in fixture home: one of everything it maps, one of everything it must refuse, and
 * the judgment calls (localhost demotion, credential heuristic, baked-name renaming) asserted by name. */

const CONFIG = `
model:
  provider: anthropic
  model: claude-opus-4
fallback_providers:
  - provider: openrouter
    model: google/gemini-2.5-flash
mcp_servers:
  linear:
    url: sse+https://mcp.linear.app/sse
    headers:
      Authorization: Bearer lin_abc123
  local-notes:
    command: node
    args: ["notes-server.js"]
providers:
  ollama:
    type: openai
    base_url: http://localhost:11434/v1
  gateway:
    type: anthropic
    base_url: https://llm.corp.example/v1
    api_key_env: GATEWAY_KEY
platforms:
  telegram:
    enabled: true
    bot_token: "\${TELEGRAM_BOT_TOKEN}"
  discord:
    enabled: false
cron:
  jobs:
    - name: daily digest
      schedule: "0 9 * * *"
      prompt: Summarize my inbox and post highlights.
    - name: broken
      schedule: not a cron
      prompt: never runs
`;

const fixture = (): Map<string, Buffer> =>
    new Map(
        Object.entries({
            "config.yaml": CONFIG,
            ".env": "TELEGRAM_BOT_TOKEN=123:abc\nOPENAI_API_KEY=sk-x\nHERMES_STREAM_READ_TIMEOUT=1800\nGATEWAY_KEY=gk-1\n",
            "auth.json": JSON.stringify({ nous_portal: { access_token: "t", refresh_token: "r" }, anthropic: { api_key: "sk-ant-1" } }),
            "SOUL.md": "Be warm, be brief.",
            "AGENTS.md": "Always confirm before sending email.",
            "memories/MEMORY.md": "The user's dog is called Pixel.",
            "memories/USER.md": "Works Berlin hours.",
            "skills/weather/SKILL.md": "---\nname: weather\ndescription: Fetch the forecast.\n---\nUse wttr.in.",
            "skills/pack/nested/SKILL.md": "---\ndescription: A nested one.\n---\nNested body.",
            "skills/lsp/SKILL.md": "---\ndescription: Collides with a baked tool.\n---\nBody.",
            "cron/jobs.json": JSON.stringify([{ name: "water plants", cron: "0 */4 * * *", message: "Remind me to water the plants." }]),
            "NOTES.md": "Loose note at the root.",
        }).map(([path, content]) => [path, Buffer.from(content)]),
    );

const byId = (planned: readonly PlannedItem[], id: string): PlannedItem | undefined => planned.find((entry) => entry.item.id === id);

test("detect answers for a hermes home and not for a random tree", () => {
    expect(detectHermes(fixture())).toBe(true);
    expect(detectHermes(new Map([["config.yaml", Buffer.from("x: 1")]]))).toBe(false);
    expect(detectHermes(new Map([["README.md", Buffer.from("hi")]]))).toBe(false);
});

test("memory: SOUL, AGENTS and the memories folder each become their own fenced item", () => {
    const { planned } = planHermes(fixture());
    expect(byId(planned, "memory:soul")?.apply).toMatchObject({ target: "memory", fence: "intentic:imported-hermes:soul" });
    expect(byId(planned, "memory:agents")?.apply).toMatchObject({ target: "memory", fence: "intentic:imported-hermes:agents" });
    const memories = byId(planned, "memory:memories");
    expect(memories?.apply.target).toBe("memory");
    expect(memories?.apply.target === "memory" ? memories.apply.body : "").toContain("Pixel");
    expect(memories?.apply.target === "memory" ? memories.apply.body : "").toContain("memories/USER.md");
});

test("skills: flattened, baked names renamed, descriptions defaulted", () => {
    const { planned } = planHermes(fixture());
    expect(byId(planned, "skill:weather")?.apply).toMatchObject({ target: "skill", skill: { name: "weather", description: "Fetch the forecast." } });
    // Nested skill keeps its own directory's name, as Hermes' own migrations flatten.
    expect(byId(planned, "skill:nested")).toBeDefined();
    // `lsp` is a baked tool here — the import must not claim its switch.
    expect(byId(planned, "skill:lsp")).toBeUndefined();
    expect(byId(planned, "skill:lsp-imported")).toBeDefined();
});

test("secrets: every .env key is offered, only credential-shaped ones recommended, auth.json api_key joins", () => {
    const { planned, refused } = planHermes(fixture());
    expect(byId(planned, "secret:TELEGRAM_BOT_TOKEN")?.item.recommended).toBe(true);
    expect(byId(planned, "secret:OPENAI_API_KEY")?.item.recommended).toBe(true);
    expect(byId(planned, "secret:HERMES_STREAM_READ_TIMEOUT")?.item.recommended).toBe(false);
    expect(byId(planned, "secret:ANTHROPIC_API_KEY")?.apply).toMatchObject({ target: "secret", value: "sk-ant-1" });
    // OAuth blobs are bound to that install — refused, with the reason.
    expect(refused.some((line) => line.includes("nous_portal OAuth"))).toBe(true);
});

test("mcp: a URL-served server becomes a capability (transport prefix stripped, bearer as token); a command-run one becomes an action", () => {
    const { planned, needsAction } = planHermes(fixture());
    const linear = byId(planned, "capability:mcp:linear");
    expect(linear?.apply).toMatchObject({
        target: "capability",
        capability: { kind: "mcp", config: { url: "https://mcp.linear.app/sse", token: "lin_abc123" } },
        secretFields: ["token"],
    });
    expect(linear?.item.secrets).toEqual(["linear/token"]);
    expect(needsAction.some((entry) => entry.subject.includes("local-notes"))).toBe(true);
});

test("providers: base_url entries become endpoints; localhost is demoted, not dropped", () => {
    const { planned } = planHermes(fixture());
    const ollama = byId(planned, "capability:endpoint:ollama");
    expect(ollama?.item.recommended).toBe(false);
    expect(ollama?.item.detail).toContain("old machine");
    const gateway = byId(planned, "capability:endpoint:gateway");
    expect(gateway?.item.recommended).toBe(true);
    expect(gateway?.apply).toMatchObject({
        target: "capability",
        capability: { kind: "endpoint", config: { baseUrl: "https://llm.corp.example/v1", protocol: "anthropic", apiKey: "gk-1" } },
        secretFields: ["apiKey"],
    });
});

test("cron: valid jobs from config.yaml and cron/ become held-for-approval automations; a bad expression is refused", () => {
    const { planned, refused } = planHermes(fixture());
    const digest = byId(planned, "automation:hermes-daily-digest");
    expect(digest?.apply).toMatchObject({
        target: "automation",
        automation: { trigger: { kind: "schedule", cron: "0 9 * * *" }, requireApproval: true, enabled: true },
    });
    expect(byId(planned, "automation:hermes-water-plants")).toBeDefined();
    expect(refused.some((line) => line.includes("daily digest"))).toBe(false);
    expect(refused.some((line) => line.includes("broken"))).toBe(true);
});

test("the known-not-to-move list: enabled channels, the model to pick, fallback chains", () => {
    const { needsAction, refused } = planHermes(fixture());
    const telegram = needsAction.find((entry) => entry.subject === "Reconnect telegram");
    expect(telegram?.detail).toContain("TELEGRAM_BOT_TOKEN");
    // Disabled channels say nothing — there is nothing to reconnect.
    expect(needsAction.some((entry) => entry.subject === "Reconnect discord")).toBe(false);
    expect(needsAction.find((entry) => entry.subject === "Pick your model provider")?.detail).toContain("Claude");
    expect(refused.some((line) => line.includes("fallback_providers"))).toBe(true);
});

test("loose root notes ride to imports/hermes/, and ids are deterministic across two derivations", () => {
    const first = planHermes(fixture());
    expect(byId(first.planned, "file:NOTES.md")?.apply).toMatchObject({ target: "file", relPath: "imports/hermes/NOTES.md" });
    const second = planHermes(fixture());
    expect(second.planned.map((entry) => entry.item.id)).toEqual(first.planned.map((entry) => entry.item.id));
});

test("a home with an unreadable config still plans the files, refusing the config by name", () => {
    const files = fixture();
    files.set("config.yaml", Buffer.from("model: [unclosed"));
    const { planned, refused } = planHermes(files);
    expect(byId(planned, "memory:soul")).toBeDefined();
    expect(byId(planned, "skill:weather")).toBeDefined();
    expect(refused.some((line) => line.includes("not readable as YAML"))).toBe(true);
});
