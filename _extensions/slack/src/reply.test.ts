import { type ListenerDispatchFrame, type Logger, runRegistry } from "@intentic/connector-runtime";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { type ChatPostMessageArguments, type WebClient, WebAPIPlatformError } from "@slack/web-api";
import type { SlackConnection } from "./client.js";
import { createSlackReply, REACTIONS, type StatusStyle, WORKING_STATUS, withoutBroadcasts } from "./reply.js";

// What a reply looks like in Slack, against a recording fake of the Web API: the shared lifecycle is tested in
// connector-runtime; this is only what Slack does differently.

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const refusal = (code: string): WebAPIPlatformError => new WebAPIPlatformError({ ok: false, error: code });

interface FakeOptions {
    readonly statusError?: string;
    readonly reactionError?: string;
    readonly startError?: string;
    readonly appendError?: string;
}

const fakeSlack = (options: FakeOptions = {}) => {
    const calls: string[] = [];
    const posted: ChatPostMessageArguments[] = [];
    // Every streaming call, by method, with what it sent.
    const streamed: Array<{ readonly method: string; readonly args: object }> = [];
    // Only the Web API methods a reply calls are here; any other throws by name on use.
    const web = unstubbed<WebClient>("web", {
        chat: unstubbed<WebClient["chat"]>("chat", {
            postMessage: async (args) => {
                posted.push(args);
                return { ok: true, ts: `9.${posted.length}` };
            },
            update: async () => ({ ok: true }),
            startStream: async (args) => {
                streamed.push({ method: "start", args });
                if (options.startError !== undefined) {
                    throw refusal(options.startError);
                }
                return { ok: true, ts: "7.1" };
            },
            appendStream: async (args) => {
                streamed.push({ method: "append", args });
                if (options.appendError !== undefined) {
                    throw refusal(options.appendError);
                }
                return { ok: true };
            },
            stopStream: async (args) => {
                streamed.push({ method: "stop", args });
                return { ok: true };
            },
        }),
        reactions: unstubbed<WebClient["reactions"]>("reactions", {
            add: async ({ name }) => {
                calls.push(`+${name}`);
                if (options.reactionError !== undefined) {
                    throw refusal(options.reactionError);
                }
                return { ok: true };
            },
            remove: async ({ name }) => {
                calls.push(`-${name ?? ""}`);
                return { ok: true };
            },
        }),
        assistant: unstubbed<WebClient["assistant"]>("assistant", {
            threads: unstubbed<WebClient["assistant"]["threads"]>("threads", {
                setStatus: async ({ status }) => {
                    calls.push(`status: ${status}`);
                    if (options.statusError !== undefined) {
                        throw refusal(options.statusError);
                    }
                    return { ok: true };
                },
            }),
        }),
    });
    const connection = unstubbed<SlackConnection>("connection", { appToken: "xapp-1", selfUserId: "U0BOT", web });
    return { connection, calls, posted, streamed };
};

const refusable = (refused: Set<string>) => ({ refused: () => refused.has("xapp-1"), refuse: () => void refused.add("xapp-1") });

interface ReplyOptions {
    readonly refused?: Set<string>;
    readonly style?: StatusStyle;
    readonly streamRefused?: Set<string>;
    readonly onStreamStopped?: () => void;
}

const replyTo = (slack: ReturnType<typeof fakeSlack>, options: ReplyOptions = {}) =>
    createSlackReply(
        {
            connection: slack.connection,
            log: quiet,
            detail: "steps",
            style: options.style ?? "card",
            registry: runRegistry(),
            status: refusable(options.refused ?? new Set()),
            streaming: refusable(options.streamRefused ?? new Set()),
            timing: { cardAfterMs: 0, editEveryMs: 5, refreshEveryMs: 10_000, typingEveryMs: 10_000, typingMaxMs: 60_000, mentionAfterMs: -1, now: Date.now },
        },
        {
            channel: "C1",
            messageTs: "1.0",
            thread: "1.0",
            askerId: "U1",
            teamId: "T1",
            place: "C1/1.0",
            onTaken: () => {},
            onStreamStopped: options.onStreamStopped ?? (() => {}),
        },
    );

const frame = (over: Partial<ListenerDispatchFrame>): ListenerDispatchFrame => ({ automationId: "a", ...over });

test("reactions are shortcodes, the thread shows Slack's own working status, cleared when the turn ends", async () => {
    const slack = fakeSlack();
    const reply = replyTo(slack);
    reply.frame(frame({ opened: { conversationId: "conv-1" } }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(slack.calls).toEqual([`status: ${WORKING_STATUS}`, `+${REACTIONS.heard}`, "status: ", `+${REACTIONS.done}`, `-${REACTIONS.heard}`]);
});

test("an app Slack refuses the working status is not asked again", async () => {
    const slack = fakeSlack({ statusError: "not_allowed" });
    const refused = new Set<string>();
    await replyTo(slack, { refused }).settle();
    expect(refused.has("xapp-1")).toBe(true);
    await replyTo(slack, { refused }).settle();
    expect(slack.calls.filter((call) => call.startsWith("status"))).toEqual([`status: ${WORKING_STATUS}`]);
});

test("a reaction already there is no failure", async () => {
    const slack = fakeSlack({ reactionError: "already_reacted" });
    const reply = replyTo(slack);
    reply.frame(frame({ opened: { conversationId: "conv-2" } }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(slack.calls).toContain(`+${REACTIONS.done}`);
});

test("a late answer names the asker above the Markdown, and never pages a channel", async () => {
    const slack = fakeSlack();
    const reply = replyTo(slack);
    reply.frame(frame({ opened: { conversationId: "conv-3" } }));
    reply.frame(frame({ delta: "Deployed. <!channel> was in the log, as was <!subteam^S123|@oncall>." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(slack.posted).toEqual([
        {
            channel: "C1",
            thread_ts: "1.0",
            text: "Deployed. @channel was in the log, as was @oncall.",
            blocks: [
                { type: "section", text: { type: "mrkdwn", text: "<@U1>" } },
                { type: "markdown", text: "Deployed. @channel was in the log, as was @oncall." },
            ],
            unfurl_links: false,
            unfurl_media: false,
        },
    ]);
    expect(withoutBroadcasts("<!here|here> and <!everyone>")).toBe("@here and @everyone");
});

const LINK = "https://app.intentic.dev/?conversation=conv-9";
const READING = { id: "s1", tool: "Read", kind: "read" as const, target: "src/auth.ts" };

test("native: work under way streams into one message, its steps as Slack's tasks, the answer below, the link at the end", async () => {
    const slack = fakeSlack();
    const reply = replyTo(slack, { style: "native" });
    reply.frame(frame({ opened: { conversationId: "conv-9", link: LINK } }));
    reply.frame(frame({ step: { ...READING, status: "running" } }));
    await waitFor(() => expect(slack.streamed.map((call) => call.method)).toContain("start"));
    reply.frame(frame({ step: { ...READING, status: "done" } }));
    reply.frame(frame({ delta: "Fixed the redirect guard." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    const [start, ...rest] = slack.streamed;
    expect(start?.args).toMatchObject({
        channel: "C1",
        thread_ts: "1.0",
        task_display_mode: "plan",
        recipient_user_id: "U1",
        recipient_team_id: "T1",
        chunks: [{ type: "plan_update" }, { type: "task_update", id: "s1", title: "Reading src/auth.ts", status: "in_progress" }],
    });
    // The answer is appended into the stream rather than posted as a message of its own.
    expect(rest.map((call) => call.method)).toEqual(["append", "stop"]);
    // These tests count every answer as late, so it names the asker.
    expect(rest[0]?.args).toMatchObject({ ts: "7.1", chunks: [{ type: "markdown_text", text: "<@U1> Fixed the redirect guard." }] });
    expect(rest[1]?.args).toMatchObject({
        ts: "7.1",
        chunks: [{ type: "plan_update", title: expect.stringMatching(/^Done · /) }, { type: "task_update", id: "s1", title: "Read src/auth.ts", status: "complete" }],
        blocks: [{ type: "actions", elements: [{ url: LINK }] }],
    });
    expect(slack.posted).toEqual([]);
});

test("native: a workspace that refuses streams gets the card, and is not asked again", async () => {
    const slack = fakeSlack({ startError: "not_allowed" });
    const streamRefused = new Set<string>();
    const reply = replyTo(slack, { style: "native", streamRefused });
    reply.frame(frame({ opened: { conversationId: "conv-10" } }));
    reply.frame(frame({ step: { ...READING, status: "running" } }));
    await waitFor(() => expect(slack.posted).toHaveLength(1));
    expect(slack.posted[0]).toMatchObject({ text: "⚙️ Working · 0s" });
    expect(streamRefused.has("xapp-1")).toBe(true);
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(slack.streamed.map((call) => call.method)).toEqual(["start"]);
});

test("native: a request held for approval shows the card, not a stream left open while it waits", async () => {
    const slack = fakeSlack();
    const reply = replyTo(slack, { style: "native" });
    reply.frame(frame({ held: "This needs the owner's approval before I start on it." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(slack.streamed).toEqual([]);
    expect(slack.posted[0]).toMatchObject({ text: "✋ Waiting for approval" });
});

test("native: Slack's own stop on the stream asks for the turn to stop, and the answer still arrives", async () => {
    const slack = fakeSlack({ appendError: "stopped_by_user" });
    let stopped = 0;
    const reply = replyTo(slack, { style: "native", onStreamStopped: () => (stopped += 1) });
    reply.frame(frame({ opened: { conversationId: "conv-11" } }));
    reply.frame(frame({ step: { ...READING, status: "running" } }));
    await waitFor(() => expect(slack.streamed.map((call) => call.method)).toContain("start"));
    reply.frame(frame({ delta: "Partial answer." }));
    reply.frame(frame({ end: true }));
    await reply.settle();
    expect(stopped).toBe(1);
    expect(slack.posted).toMatchObject([{ text: "Partial answer." }]);
    expect(slack.posted).toHaveLength(1);
});
