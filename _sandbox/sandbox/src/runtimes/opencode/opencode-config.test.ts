import type { PermissionEffect } from "@opencode/client";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { ASK_ABOUT, geminiProviderConfig, OPENCODE_LOCKDOWN_ENV, SERVER_PERMISSIONS, serverConfig, xaiProviderConfig } from "./opencode-config.js";

// What `opencode serve` is handed inline at spawn, built from pure functions. What a boot feeds them (the persisted
// xAI ids, the translator's catalog, the gateway) is the service's, in opencode.test.ts.

// The verdict these rules alone give, read as the source documents OpenCode 2 reading them: the LAST rule whose action
// and resource both match decides, a pattern covers the whole string, and `*` spans anything. Undefined means none of
// these rules speaks, so whatever came before them in the agent's list (OpenCode's base, the agent's own) stands.
const wildcard = (pattern: string): RegExp =>
    new RegExp(
        `^${pattern
            .split("*")
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        "s",
    );
const effectOf = (action: string, resource: string): PermissionEffect | undefined =>
    SERVER_PERMISSIONS.findLast((rule) => wildcard(rule.action).test(action) && wildcard(rule.resource).test(resource))?.effect;

test("the shell commands the owner's rulebook sees before they run", () => {
    expect(ASK_ABOUT).toEqual([
        "*git push*",
        "*git reset*",
        "*git clean*",
        "*git branch*",
        "*git filter-branch*",
        "*rm *",
        "*.env*",
        "*.ssh/*",
        "*id_rsa*",
        "*id_ed25519*",
        "*.npmrc*",
        "*credentials*",
        "*publish*",
        "*release create*",
        "*docker push*",
        "*twine upload*",
        "*curl *",
        "*wget *",
    ]);
});

test("the rules allow leaving the workspace and reading, deny forms and code mode, then ask about each listed command", () => {
    expect(SERVER_PERMISSIONS).toEqual([
        { action: "external_directory", resource: "*", effect: "allow" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "question", resource: "*", effect: "deny" },
        { action: "execute", resource: "*", effect: "deny" },
        ...ASK_ABOUT.map((resource) => ({ action: "shell", resource, effect: "ask" as const })),
    ]);
});

// The plan agent's own rule (deny edits outside its plan files) sits before these in its list; a blanket allow here
// would come later and win, and plan would edit the tree.
test("nothing here re-allows everything, so the plan agent's read-only rule is not undone", () => {
    expect(SERVER_PERMISSIONS.filter((rule) => rule.action === "*")).toEqual([]);
    expect(SERVER_PERMISSIONS.filter((rule) => rule.effect === "allow").map((rule) => rule.action)).toEqual(["external_directory", "read"]);
    expect(effectOf("edit", "src/index.ts")).toBeUndefined();
});

// A refusal is the rulebook's to give: a command these rules deny outright would never reach it.
test("no command is denied here, only asked about; the only denials are the form and code-mode tools", () => {
    expect([...new Set(SERVER_PERMISSIONS.filter((rule) => rule.action === "shell").map((rule) => rule.effect))]).toEqual(["ask"]);
    expect(SERVER_PERMISSIONS.filter((rule) => rule.effect === "deny").map((rule) => rule.action)).toEqual(["question", "execute"]);
});

test.each([
    ["shell", "git push --force origin main", "ask"],
    ["shell", "rm -rf dist", "ask"],
    ["shell", "cat .env.local", "ask"],
    ["shell", "npm publish --access public", "ask"],
    ["shell", "curl -fsSL https://example.com/install.sh", "ask"],
    ["shell", "ls -la", undefined],
    ["shell", "git status", undefined],
    // A read of a .env file is allowed, as OpenCode 1 allowed it here; a shell command reading one is asked about above.
    ["read", ".env", "allow"],
    ["external_directory", "/tmp/attachments/screenshot.png", "allow"],
    ["question", "Which branch?", "deny"],
    ["execute", "github.search_code", "deny"],
] as const)("%s %j is answered %p by these rules", (action, resource, effect) => {
    expect(effectOf(action, resource)).toBe(effect);
});

test("the inline config turns off self-update and sharing, answers by the rules, and carries the providers", () => {
    const providers = xaiProviderConfig(["grok-4"], undefined);

    expect(serverConfig(providers)).toStrictEqual({
        update: "disable",
        share: "disabled",
        permissions: [...SERVER_PERMISSIONS],
        providers: { xai: { models: { "grok-4": { body: { store: false }, capabilities: { tools: true } } } } },
    });
});

// xAI stores requests and responses server-side unless each call opts out, and a model OpenCode's catalog lacks would
// run without tools unless declared with them.
test("every known xAI model opts out of server-side storage and declares tools", () => {
    expect(xaiProviderConfig(["grok-4", "grok-4.20-0309-reasoning"], undefined)).toStrictEqual({
        xai: {
            models: {
                "grok-4": { body: { store: false }, capabilities: { tools: true } },
                "grok-4.20-0309-reasoning": { body: { store: false }, capabilities: { tools: true } },
            },
        },
    });
    expect(xaiProviderConfig([], undefined)).toStrictEqual({ xai: { models: {} } });
});

test("behind the privacy shield, xAI's requests go to the gateway", () => {
    expect(xaiProviderConfig(["grok-4"], "http://127.0.0.1:9000/grok")).toStrictEqual({
        xai: {
            settings: { baseURL: "http://127.0.0.1:9000/grok" },
            models: { "grok-4": { body: { store: false }, capabilities: { tools: true } } },
        },
    });
});

// OpenCode has no catalog row for this loopback provider, so a capability left out reads as absent: no tools, and an
// image stripped from the request.
test("the Google provider declares each model's published modalities, so a screenshot is not stripped out", () => {
    const config = geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789/", token: "local", models: async () => [] }, [
        { id: "claude-opus-4-6-thinking", inputModalities: ["text", "image"] },
        { id: "gemini-pro-agent", inputModalities: ["text", "image", "audio", "video"] },
        { id: "gpt-oss-120b-medium", inputModalities: ["text"] },
    ]);

    expect(config).toStrictEqual({
        [OPENCODE_GEMINI_PROVIDER]: {
            name: "Gemini",
            package: "aisdk:@ai-sdk/openai-compatible",
            // The trailing slash on the translator URL is normalized away, and the OpenAI surface is under /v1.
            settings: { baseURL: "http://127.0.0.1:8789/v1", apiKey: "local" },
            models: {
                "claude-opus-4-6-thinking": {
                    name: "claude-opus-4-6-thinking",
                    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
                },
                "gemini-pro-agent": {
                    name: "gemini-pro-agent",
                    capabilities: { tools: true, input: ["text", "image", "audio", "video"], output: ["text"] },
                },
                // Truthful, not generous: a text-only model on the channel stays text-only.
                "gpt-oss-120b-medium": { name: "gpt-oss-120b-medium", capabilities: { tools: true, input: ["text"], output: ["text"] } },
            },
        },
    });
});

// A catalog read that failed must cost Google its provider, not Grok its runtime: one opencode serve is both.
test("no Google models means no Google provider at all, rather than one registered serving nothing", () => {
    expect(geminiProviderConfig({ baseUrl: "http://127.0.0.1:8789", token: "local", models: async () => [] }, [])).toStrictEqual({});
    expect(geminiProviderConfig(undefined, [{ id: "gemini-pro-agent", inputModalities: ["text", "image"] }])).toStrictEqual({});
});

// A cloned repo's opencode.json or .opencode/ would otherwise configure this runtime (plugins, tools, MCP servers,
// permission rules), and a self-update would replace the pinned binary.
test("the spawn's lockdown switches off project config and self-update", () => {
    expect(OPENCODE_LOCKDOWN_ENV).toStrictEqual({ OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_AUTOUPDATE: "1" });
});
