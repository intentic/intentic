import { waitFor } from "@intentic/testing/bun";
import type { ExtensionServerApi, JobSpec, RunningJob, ToolCallContext, ToolCallGrants, ToolDefinition } from "./server.js";
import { type FakeExtension, fakeExtensionApi } from "./testing.js";

// (2026-11-26) What an extension's tools do with the turn calling them (turn-reach.ts), through the SDK's fake daemon
// (testing.ts), which judges each call as the daemon's turn doors do: the declared power, a live ticket, and the grants
// the ticket stands for.

const opened: FakeExtension[] = [];
const fake = async (options: Parameters<typeof fakeExtensionApi>[0]): Promise<FakeExtension> => {
    const made = await fakeExtensionApi(options);
    opened.push(made);
    return made;
};
afterEach(async () => {
    await Promise.all(opened.splice(0).map((each) => each.dispose()));
});

const GRANTS: ToolCallGrants = {
    accounts: [{ id: "chatgpt", kind: "browser", sites: ["chatgpt.com", "openai.com"] }],
    browsers: ["brave"],
    cards: [],
};

const ALL_POWERS = { publisher: "acme", name: "kit", permissions: { turn: ["browser", "owner-browser", "jobs"] as const } };

// A backend whose one tool hands its arguments and context to `run`, and answers what `run` answers.
const serving = (run: (api: ExtensionServerApi, args: Parameters<ToolDefinition["call"]>[0], context: ToolCallContext) => ReturnType<ToolDefinition["call"]>) => ({
    activateServer: (api: ExtensionServerApi) => {
        const tool: ToolDefinition = { name: "act", description: "acts", inputSchema: { type: "object" }, call: async (args, context) => await run(api, args, context) };
        api.tools.serve(() => [tool]);
    },
});

test("a call is handed what its turn holds and a ticket good only while it runs", async () => {
    const seen: ToolCallContext[] = [];
    const extension = await fake({ manifest: ALL_POWERS, grants: GRANTS });
    await extension.activate(
        serving(async (_api, _args, context) => {
            seen.push(context);
            return "ok";
        }),
    );
    await extension.callTool("act", {}, undefined, { conversationId: "c-1" });
    expect(seen).toEqual([{ signal: expect.any(AbortSignal), grants: GRANTS, conversationId: "c-1", ticket: expect.any(String) }]);
});

test("a tool drives an account the turn holds, on its sites, and the daemon is told the account and the tool", async () => {
    const extension = await fake({
        manifest: ALL_POWERS,
        grants: GRANTS,
        browser: (call) => ({ content: [{ type: "text", text: `${call.tool} as ${call.account}` }] }),
    });
    await extension.activate(serving(async (api, _args, context) => await api.browser.call(context, { account: "chatgpt", tool: "browser_navigate", args: { url: "https://chatgpt.com/" } })));
    expect(await extension.callTool("act", {}, undefined, { conversationId: "c-1" })).toEqual({ content: [{ type: "text", text: "browser_navigate as chatgpt" }] });
    expect(extension.browserCalls).toEqual([{ account: "chatgpt", tool: "browser_navigate", args: { url: "https://chatgpt.com/" }, conversationId: "c-1" }]);
});

test.each([
    ["an account the turn does not hold", { account: "x", tool: "browser_snapshot" }, /holds no account "x"/],
    ["a tool outside the page's own", { account: "chatgpt", tool: "browser_run_code_unsafe", args: { code: "async (page) => page.context().cookies()" } }, /not a browser tool an extension may call/],
    ["a navigation off the account's sites", { account: "chatgpt", tool: "browser_navigate", args: { url: "https://mail.google.com/" } }, /signs in on chatgpt\.com or openai\.com/],
])("the daemon refuses %s, and the browser is never asked", async (_name, call, refusal) => {
    const extension = await fake({ manifest: ALL_POWERS, grants: GRANTS });
    await extension.activate(serving(async (api, _args, context) => await api.browser.call(context, call)));
    await expect(Promise.resolve(extension.callTool("act", {}, undefined, { conversationId: "c-1" }))).rejects.toThrow(refusal);
    expect(extension.browserCalls).toEqual([]);
});

test("an undeclared power is refused before anything is sent", async () => {
    const extension = await fake({ manifest: { publisher: "acme", name: "kit", permissions: { turn: ["jobs"] as const } }, grants: GRANTS });
    await extension.activate(serving(async (api, _args, context) => await api.browser.call(context, { account: "chatgpt", tool: "browser_snapshot" })));
    await expect(Promise.resolve(extension.callTool("act", {}, undefined, { conversationId: "c-1" }))).rejects.toThrow('did not declare "browser" in permissions.turn');
    expect(extension.calls).toEqual([]);
});

test("a ticket kept past its call reaches nothing", async () => {
    let kept: ToolCallContext | undefined;
    const extension = await fake({ manifest: ALL_POWERS, grants: GRANTS });
    await extension.activate(
        serving(async (_api, _args, context) => {
            kept = context;
            return "ok";
        }),
    );
    await extension.callTool("act", {}, undefined, { conversationId: "c-1" });
    if (kept === undefined) {
        throw new Error("the tool was not called");
    }
    await expect(extension.api.browser.call(kept, { account: "chatgpt", tool: "browser_snapshot" })).rejects.toThrow(/is running under that ticket/);
    await expect(extension.api.browser.call({ grants: GRANTS }, { account: "chatgpt", tool: "browser_snapshot" })).rejects.toThrow(/carries no ticket onto its turn/);
});

test("the owner's browser is reached only when the turn holds it", async () => {
    const extension = await fake({ manifest: ALL_POWERS, grants: GRANTS, ownerBrowser: (call) => ({ content: [{ type: "text", text: `${call.tool} in ${call.browser}` }] }) });
    await extension.activate(serving(async (api, args, context) => await api.ownerBrowser.call(context, { browser: String(args["browser"]), tool: "read", args: { url: "https://chatgpt.com/" } })));
    expect(await extension.callTool("act", { browser: "brave" }, undefined, { conversationId: "c-1" })).toEqual({ content: [{ type: "text", text: "read in brave" }] });
    await expect(Promise.resolve(extension.callTool("act", { browser: "chrome" }, undefined, { conversationId: "c-1" }))).rejects.toThrow(/holds no browser of the owner's called "chrome"/);
    expect(extension.ownerBrowserCalls.map((call) => call.browser)).toEqual(["brave"]);
});

test("a job is filed in the calling conversation, its work runs with the call's grants, and its end is what the agent collects", async () => {
    const extension = await fake({ manifest: ALL_POWERS, grants: GRANTS, ownerBrowser: () => ({ content: [{ type: "text", text: "saved /artifacts/cat.png" }] }) });
    const spec = (run: JobSpec["run"]): JobSpec => ({ command: "chatgpt_image cat", description: "a cat", started: "Making a cat.", lane: { name: "brave", key: "chat-1", most: 2 }, run });
    await extension.activate(
        serving(async (api, _args, context) =>
            await api.jobs.start(
                context,
                spec(async (job) => {
                    job.say("sent");
                    const saved = await api.ownerBrowser.call(job, { browser: "brave", tool: "chatgpt_image", args: { prompt: "a cat" } });
                    return { ok: true, output: saved.content.map((block) => (block.type === "text" ? block.text : "")).join("") };
                }),
            ),
        ),
    );
    expect(await extension.callTool("act", {}, undefined, { conversationId: "c-1" })).toEqual({ id: "job-1", ahead: 0 });
    expect(await extension.jobEnd("job-1")).toEqual({ ok: true, output: "saved /artifacts/cat.png" });
    expect(extension.jobs).toEqual([
        {
            id: "job-1",
            conversationId: "c-1",
            command: "chatgpt_image cat",
            description: "a cat",
            lane: { name: "brave", key: "chat-1", most: 2 },
            lines: ["sent"],
            end: { ok: true, output: "saved /artifacts/cat.png" },
            stopped: false,
        },
    ]);
});

test("a job stopped by the agent aborts its work, and one whose work throws ends failed with the message", async () => {
    const extension = await fake({ manifest: ALL_POWERS, grants: GRANTS });
    const running: RunningJob[] = [];
    await extension.activate(
        serving(async (api, args, context) =>
            await api.jobs.start(context, {
                command: "work",
                description: "work",
                started: "Working.",
                run: async (job) => {
                    running.push(job);
                    if (args["fail"] === true) {
                        throw new Error("the page changed");
                    }
                    await new Promise<void>((resolve) => job.signal.addEventListener("abort", () => resolve()));
                    return { ok: false, output: "stopped" };
                },
            }),
        ),
    );
    await extension.callTool("act", {}, undefined, { conversationId: "c-1" });
    await waitFor(() => running.length === 1);
    extension.stopJob("job-1");
    await waitFor(() => running[0]?.signal.aborted === true);
    await extension.callTool("act", { fail: true }, undefined, { conversationId: "c-1" });
    expect(await extension.jobEnd("job-2")).toEqual({ ok: false, output: 'The job failed in extension "acme.kit": the page changed' });
});

test("a call with no conversation files no job", async () => {
    const extension = await fake({ manifest: ALL_POWERS, grants: GRANTS });
    await extension.activate(serving(async (api, _args, context) => await api.jobs.start(context, { command: "work", description: "work", started: "Working.", run: async () => ({ ok: true, output: "" }) })));
    await expect(Promise.resolve(extension.callTool("act"))).rejects.toThrow(/no conversation to file a job in/);
    expect(extension.jobs).toEqual([]);
});
