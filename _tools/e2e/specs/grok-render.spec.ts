import { expect, test } from "@playwright/test";

// Grok chat must render a streamed turn without crashing the assistant bubble. This is the regression guard for
// the `undefined is not an object (evaluating 'W.type')` class of failure: the Grok adapter streams chunky
// PARTIAL-markdown snapshots, and ChatMessageView re-runs the markdown renderer on every delta, so a single
// throw in that render path blanks the turn. The daemon is fully mocked here (no real xAI account, no live
// agent): we drive the real Vue app + real render pipeline against canned Grok frames that deliberately stress
// the renderer with mid-table / unclosed-code-fence / mid-list partial states.

// The frames the daemon's Grok adapter emits (see intentic/_sandbox/sandbox/src/grok/grok-agent.ts), split so each
// accumulated prefix is INVALID/partial markdown at the moment it renders.
const DELTA_CHUNKS = [
    "Yes, I'm here and wired into chat. Quick status:\n\n| Piece | St", // mid table header
    "ate |\n|-------|---", // mid separator row
    "----|\n| Grok  | live  |\n\n```ts\nconst ok", // opened, unclosed code fence
    " = true;\n``", // fence almost closed
    "`\n\n- streaming markdown\n- tables an", // mid list item
    "d code\n- no crashes\n",
];

const FINAL_TEXT = "no crashes";

const sseBody = (): string => {
    const frames = [
        { kind: "session", sessionId: "grok-s1" },
        ...DELTA_CHUNKS.map((text) => ({ kind: "delta", text })),
        { kind: "tool", id: "t1", name: "Bash", target: "echo hi" },
        { kind: "tool_result", id: "t1", output: "hi" },
        { kind: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 },
        { kind: "done" },
    ];
    // The client's consumer splits on a blank line and reads the `data:` line (it ignores oRPC's event:/id: lines).
    return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
};

test("a streamed Grok turn renders (partial markdown, table, code, tool) without crashing the bubble", async ({ page }) => {
    const pageErrors: string[] = [];
    const vueErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
        // main.ts's app.config.errorHandler prefixes caught render/lifecycle errors with "[vue]".
        if (msg.type() === "error" && msg.text().startsWith("[vue]")) {
            vueErrors.push(msg.text());
        }
    });

    // Mock only the provider endpoints + the turn: Grok connected with a live model; the other providers empty
    // so the composer auto-selects Grok. Everything else (liveness, /system/*) hits the real loopback daemon.
    await page.route("**/grok/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "grok-1", label: "Grok" }] } }));
    await page.route("**/providers/grok/models", (route) =>
        route.fulfill({ json: { models: [{ id: "grok-4", label: "Grok 4" }], default: "grok-4" } }),
    );
    await page.route("**/claude/accounts", (route) => route.fulfill({ json: { accounts: [] } }));
    await page.route("**/codex/accounts", (route) => route.fulfill({ json: { accounts: [] } }));

    let agentBody: { agent?: string; model?: string } | undefined;
    await page.route("**/agent", (route) => {
        agentBody = JSON.parse(route.request().postData() ?? "{}") as { agent?: string; model?: string };
        return route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sseBody() });
    });

    await page.goto("/workspace");

    // The composer only renders once a provider is connected; with only Grok connected the unlocked conversation
    // auto-switches to it. name="draft" is the stable handle regardless of the placeholder text.
    const composer = page.locator('textarea[name="draft"]');
    await expect(composer).toBeVisible({ timeout: 30_000 });

    await composer.fill("U there Grok?");
    await page.getByRole("button", { name: "Send" }).click();

    // The turn was sent as a Grok turn (proves the mock served the real send path, not a different provider).
    await expect.poll(() => agentBody?.agent, { timeout: 15_000 }).toBe("grok");

    // The assistant bubble renders the streamed markdown: the final text lands AND the table became real HTML.
    const assistant = page.locator(".chat-surface-assistant").last();
    await expect(assistant).toContainText(FINAL_TEXT, { timeout: 20_000 });
    await expect(assistant.locator("table")).toBeVisible();
    await expect(assistant.locator("code")).toContainText("const ok = true;");

    // The tool card rendered too (Grok's tool/tool_result frames).
    await expect(page.getByText("echo hi")).toBeVisible();

    // No red error line, and, the point of this test, no render crash surfaced anywhere.
    await expect(page.locator("p.text-danger")).toHaveCount(0);
    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);

    await page.screenshot({ path: "./.cache/grok-render.png", fullPage: true });
});
