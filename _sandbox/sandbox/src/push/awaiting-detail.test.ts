import type { AgentEvent, AskQuestion, PushNotification } from "@intentic/sandbox-contract";
import { TranscriptFold } from "@intentic/sandbox-contract/transcript-fold";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../composition.js";
import { conversationEntry } from "../testing.js";
import { awaitingCard, notifyAwaiting } from "./awaiting-detail.js";
import { turnAwaiting } from "./notifications.js";

/* A notification for a waiting card says who waits (the conversation's title) and on what (the card's own line),
 * read off the conversation's live run, since every raiser announces only the card's kind. */

// A live run's transcript: the frames the card raisers push, folded by the run's own fold and never finished, which
// would settle every card still waiting.
const liveFold = (...frames: AgentEvent[]): TranscriptFold => {
    const fold = new TranscriptFold([]);
    for (const frame of frames) {
        fold.apply(frame);
    }
    return fold;
};
const rowsOf = (...frames: AgentEvent[]) => liveFold(...frames).rows;

const ask = (question: string, header = "Choice"): AskQuestion => ({
    question,
    header,
    multiSelect: false,
    options: [{ label: "Yes", description: "Go ahead." }],
});

const permission = (requestId: string, words: { title?: string; displayName?: string } = {}): AgentEvent => ({
    kind: "permission",
    requestId,
    toolName: "Bash",
    ...words,
});

const payment = (requestId: string, url: string): AgentEvent => ({
    kind: "payment_offer",
    requestId,
    offer: {
        url,
        payTo: "0x1111111111111111111111111111111111111111",
        network: "eip155:8453",
        asset: "0x2222222222222222222222222222222222222222",
        assetName: "USDC",
        amountUsd: "0.05",
        spentTodayUsd: "1.20",
        dailyCapUsd: "5.00",
    },
});

describe("the card's line", () => {
    test("a question leads with its first question, and counts the rest on the card", () => {
        const two = rowsOf({ kind: "question", requestId: "q1", questions: [ask("Which database should it use?"), ask("Migrate now?")] });
        expect(awaitingCard(two, "question")).toEqual({ requestId: "q1", detail: "Which database should it use? (+1 more)" });

        const one = rowsOf({ kind: "question", requestId: "q2", questions: [ask("Which database should it use?")] });
        expect(awaitingCard(one, "question")).toEqual({ requestId: "q2", detail: "Which database should it use?" });

        // A blank question still has its header to say.
        const blank = rowsOf({ kind: "question", requestId: "q3", questions: [ask("  ", "Database")] });
        expect(awaitingCard(blank, "question")).toEqual({ requestId: "q3", detail: "Database" });
    });

    test("a permission says what its card's header says: the runtime's sentence, else the button's phrase, else the tool", () => {
        expect(awaitingCard(rowsOf(permission("p1", { title: "Allow Bash to run npm install?", displayName: "Run command" })), "permission")).toEqual(
            {
                requestId: "p1",
                detail: "Allow Bash to run npm install?",
            },
        );
        expect(awaitingCard(rowsOf(permission("p2", { displayName: "Run command" })), "permission")).toEqual({
            requestId: "p2",
            detail: "Run command",
        });
        expect(awaitingCard(rowsOf(permission("p3")), "permission")).toEqual({ requestId: "p3", detail: "Bash" });
    });

    test("an offer names what it is for: the capability, the price and where it goes, the credential", () => {
        const capability = rowsOf({
            kind: "capability_offer",
            requestId: "c1",
            offer: { entry: "notion", name: "Notion", why: "to read the notes" },
        });
        expect(awaitingCard(capability, "capability_offer")).toEqual({ requestId: "c1", detail: "Connect Notion" });

        expect(awaitingCard(rowsOf(payment("m1", "https://api.example.com/v1/weather?city=Oslo")), "payment_offer")).toEqual({
            requestId: "m1",
            detail: "$0.05 to api.example.com",
        });
        // An address that does not parse is shown whole rather than dropped.
        expect(awaitingCard(rowsOf(payment("m2", "not a url")), "payment_offer")).toEqual({ requestId: "m2", detail: "$0.05 to not a url" });

        const credential = rowsOf({
            kind: "credential_offer",
            requestId: "k1",
            offer: { subject: "DATABASE_URL", kind: "secret", lane: "shell", approvers: ["ada@example.com"], scope: "use" },
        });
        expect(awaitingCard(credential, "credential_offer")).toEqual({ requestId: "k1", detail: "DATABASE_URL" });
    });

    test("a plan is named by its heading, else by the document it points at, else by its opening line", () => {
        const headed = rowsOf({ kind: "plan", requestId: "l1", text: "# Move sessions to signed cookies\n\n1. Add the signer." });
        expect(awaitingCard(headed, "plan")).toEqual({ requestId: "l1", detail: "Move sessions to signed cookies" });

        const pointing = rowsOf({
            kind: "plan",
            requestId: "l2",
            text: "The plan is in the file.",
            document: { path: "plans/cookies.md", title: "Cookie migration", markdown: "# Cookie migration" },
        });
        expect(awaitingCard(pointing, "plan")).toEqual({ requestId: "l2", detail: "Cookie migration" });

        expect(awaitingCard(rowsOf({ kind: "plan", requestId: "l3", text: "\nFirst add the signer.\nThen switch reads." }), "plan")).toEqual({
            requestId: "l3",
            detail: "First add the signer.",
        });
    });

    test("a hand-over repeats what the agent says it needs done", () => {
        const browser = rowsOf({
            kind: "browser_help",
            requestId: "b1",
            session: "s1",
            account: "github",
            message: "Solve the captcha on github.com",
        });
        expect(awaitingCard(browser, "browser_help")).toEqual({ requestId: "b1", detail: "Solve the captcha on github.com" });

        const terminal = rowsOf({ kind: "terminal_help", requestId: "t1", session: "s2", message: "Type the code from your authenticator" });
        expect(awaitingCard(terminal, "terminal_help")).toEqual({ requestId: "t1", detail: "Type the code from your authenticator" });
    });

    test("the newest card of the kind still waiting is the one read; an answered one, or one of another kind, is not", () => {
        const fold = liveFold(permission("older", { title: "Allow reading .env?" }), permission("newer", { title: "Allow npm install?" }));
        expect(awaitingCard(fold.rows, "permission")).toEqual({ requestId: "newer", detail: "Allow npm install?" });

        fold.apply({ kind: "resolved", requestId: "newer", reply: { kind: "permission", requestId: "newer", decision: "once" } });
        expect(awaitingCard(fold.rows, "permission")).toEqual({ requestId: "older", detail: "Allow reading .env?" });

        fold.apply({ kind: "resolved", requestId: "older", reply: { kind: "permission", requestId: "older", decision: "deny" } });
        expect(awaitingCard(fold.rows, "permission")).toBeUndefined();

        // A question waiting says nothing about a permission.
        expect(awaitingCard(rowsOf({ kind: "question", requestId: "q1", questions: [ask("Which one?")] }), "permission")).toBeUndefined();
    });
});

describe("the notification's words", () => {
    test("with neither the card nor a title to go on, it says exactly what it always said, once per conversation", () => {
        expect(turnAwaiting("conv-1", "permission")).toEqual({
            title: "Permission needed",
            body: "The agent is waiting for you to allow a tool it wants to run.",
            url: "/?conversation=conv-1",
            tag: "awaiting-conv-1",
            requireInteraction: true,
        });
    });

    test("it names who waits and on what, and stands per card", () => {
        expect(turnAwaiting("conv-1", "payment_offer", { requestId: "m1", detail: "$0.05 to api.example.com" }, "Fix the login redirect")).toEqual({
            title: "Fix the login redirect: a payment to approve",
            body: "$0.05 to api.example.com",
            url: "/?conversation=conv-1",
            tag: "awaiting-m1",
            requireInteraction: true,
        });
        // A card with no line of its own keeps the kind's sentence, and still its own tag.
        expect(turnAwaiting("conv-1", "question", { requestId: "q1" }, "Fix the login redirect")).toMatchObject({
            title: "Fix the login redirect: a question for you",
            body: "It stopped to ask you something before continuing.",
            tag: "awaiting-q1",
        });
    });

    test("two cards waiting in one conversation are two notifications; the same card announced again is still one", () => {
        const first = turnAwaiting("conv-1", "permission", { requestId: "p1", detail: "Allow npm install?" });
        const second = turnAwaiting("conv-1", "permission", { requestId: "p2", detail: "Allow reading .env?" });
        expect([first.tag, second.tag]).toEqual(["awaiting-p1", "awaiting-p2"]);
        expect(turnAwaiting("conv-1", "permission", { requestId: "p1" }).tag).toBe(first.tag);
    });

    test("a long title is cut at a word to fit a lock screen, and a blank one is no title", () => {
        const long = "Rework the whole billing export so that every invoice carries its tax lines";
        expect(turnAwaiting("conv-1", "plan", undefined, long).title).toBe("Rework the whole billing export so that…: plan ready for review");
        expect(turnAwaiting("conv-1", "plan", undefined, "   ").title).toBe("Plan ready for review");
    });
});

describe("telling the devices", () => {
    // The seams it reads: the conversation's title, and the sender, which records what it was asked to send.
    const wired = (title?: string) => {
        const sent: PushNotification[] = [];
        const services: Pick<Services, "agents" | "pushSender"> = {
            agents: unstubbed<Services["agents"]>("agents", {
                entry: (id) =>
                    id !== "conv-1"
                        ? undefined
                        : conversationEntry({
                              id,
                              social: title === undefined ? { reactions: [] } : { title: { text: title, source: "derived" }, reactions: [] },
                          }),
            }),
            pushSender: unstubbed<Services["pushSender"]>("pushSender", {
                notifyIfAway: async (notification) => {
                    sent.push(notification);
                    return { delivered: 1, failed: 0 };
                },
            }),
        };
        return { services, sent };
    };

    test("a card the turn raised is read though it folds into the run only after it was announced", async () => {
        const { services, sent } = wired("Fix the login redirect");
        const fold = liveFold();
        const run = {
            get rows() {
                return fold.rows;
            },
        };
        // As the turn's pump does: announce the card, then fold its frame in the same step.
        const told = notifyAwaiting(services, { conversationId: "conv-1", kind: "question", run });
        fold.apply({ kind: "question", requestId: "q1", questions: [ask("Which database should it use?")] });
        await told;

        expect(sent).toEqual([
            {
                title: "Fix the login redirect: a question for you",
                body: "Which database should it use?",
                url: "/?conversation=conv-1",
                tag: "awaiting-q1",
                requireInteraction: true,
            },
        ]);
    });

    test("the card after it is not read as it: the turn folds its next frame only once it next awaits", async () => {
        const { services, sent } = wired("Fix the login redirect");
        const fold = liveFold();
        const run = {
            get rows() {
                return fold.rows;
            },
        };
        const told = notifyAwaiting(services, { conversationId: "conv-1", kind: "permission", run });
        fold.apply(permission("p1", { title: "Allow npm install?" }));
        await Promise.resolve();
        fold.apply(permission("p2", { title: "Allow reading .env?" }));
        await told;

        expect(sent.map((notification) => [notification.tag, notification.body])).toEqual([["awaiting-p1", "Allow npm install?"]]);
    });

    test("with no run to read and no title, the notification is the kind's own words, once per conversation", async () => {
        const { services, sent } = wired();
        await notifyAwaiting(services, { conversationId: "conv-1", kind: "terminal_help", run: undefined });
        expect(sent).toEqual([
            {
                title: "The agent's terminal needs you",
                body: "A command it started is waiting at a prompt only you can answer.",
                url: "/?conversation=conv-1",
                tag: "awaiting-conv-1",
                requireInteraction: true,
            },
        ]);
    });
});
