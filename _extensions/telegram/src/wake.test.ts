import { waitFor } from "@intentic/testing/bun";
import { ALLOWED_UPDATES } from "./client.js";
import { judgeWakeCall, type Parked, type ParkedDocument, parkBeforeSleep, webhookSecret, wakeWebhooks } from "./wake.js";

// Hosted sleep's webhook (wake.ts) with the Bot API stood in for: what the before-sleep hook asks Telegram, what a start
// clears (only this sandbox's own webhook), and how the wake door tells Telegram's deliveries from anyone else's calls.

const TOKEN = "123456789:AAH-first-secret-part";
const OTHER = "987654321:BBX-second-secret-part";
const WAKE_URL = "https://sbx.example.test/door/intentic.telegram/wake?wake=s3cret";
const DOOR = "https://sbx.example.test/door/intentic.telegram/wake";

const memoryDocument = (initial: Parked = {}): ParkedDocument & { readonly stored: () => Parked } => {
    let stored = initial;
    return {
        read: async () => stored,
        update: async (change) => {
            stored = change(stored);
            return stored;
        },
        stored: () => stored,
    };
};

interface Called {
    readonly method: string;
    readonly body: object | undefined;
}

// One bot as the Bot API answers it: an answer per method (one that throws is Telegram refusing), every call recorded.
const bot = (botToken: string, answers: Readonly<Record<string, (body: object | undefined) => object | boolean>> = {}) => {
    const calls: Called[] = [];
    return {
        botToken,
        username: "acme_bot",
        calls,
        call: async <T>(method: string, body?: object): Promise<T> => {
            calls.push({ method, body });
            // SAFETY: each test answers a method with the shape that method's caller reads.
            return (answers[method]?.(body) ?? true) as T;
        },
    };
};

const logged = () => {
    const warnings: string[] = [];
    return { warnings, log: { info: () => undefined, warn: (_fields: object, message: string) => void warnings.push(message) } };
};

describe("the secret a wake webhook carries", () => {
    test("names its bot, is one Telegram accepts, and gives nothing of the token away", () => {
        const secret = webhookSecret(TOKEN);
        expect(secret).toMatch(/^123456789_[A-Za-z0-9_-]+$/u);
        expect(secret.length).toBeLessThanOrEqual(256);
        expect(secret).not.toContain("AAH-first-secret-part");
        expect(webhookSecret("123456789:a-replaced-token")).not.toBe(secret);
    });

    test("tells Telegram delivering for this sandbox's bot from everything else", () => {
        const tokens = [TOKEN, OTHER];
        expect(judgeWakeCall(webhookSecret(TOKEN), tokens)).toBe("ours");
        expect(judgeWakeCall(webhookSecret(OTHER), tokens)).toBe("ours");
        // The bot's id with a secret its token did not make: a guess, or a webhook set under a token since replaced.
        expect(judgeWakeCall(webhookSecret("123456789:a-replaced-token"), tokens)).toBe("wrong");
        expect(judgeWakeCall("123456789_guessed", tokens)).toBe("wrong");
        // A bot no card here holds any more.
        expect(judgeWakeCall(webhookSecret("555:a-removed-bot"), tokens)).toBe("gone");
        expect(judgeWakeCall(null, tokens)).toBe("stranger");
        expect(judgeWakeCall("", tokens)).toBe("stranger");
        expect(judgeWakeCall("not ours at all", tokens)).toBe("stranger");
    });
});

describe("before a hosted sleep", () => {
    test("each bot is pointed at the wake door with its secret and the updates the poll asks for, written down first", async () => {
        const parked = memoryDocument();
        const { log, warnings } = logged();
        const recordedWhenAsked: Parked[] = [];
        const first = bot(TOKEN, {
            setWebhook: () => {
                recordedWhenAsked.push(parked.stored());
                return true;
            },
        });
        const second = bot(OTHER, {
            setWebhook: () => {
                throw new Error("telegram 502: Bad Gateway");
            },
        });
        await wakeWebhooks({ parked, wakeUrl: async () => WAKE_URL, log }).park([first, second]);
        expect(first.calls).toEqual([{ method: "setWebhook", body: { url: WAKE_URL, secret_token: webhookSecret(TOKEN), allowed_updates: ALLOWED_UPDATES } }]);
        expect(second.calls).toEqual([{ method: "setWebhook", body: { url: WAKE_URL, secret_token: webhookSecret(OTHER), allowed_updates: ALLOWED_UPDATES } }]);
        expect(recordedWhenAsked).toEqual([{ "123456789": DOOR, "987654321": DOOR }]);
        // The door is written down without the wake secret in its query.
        expect(JSON.stringify(parked.stored())).not.toContain("s3cret");
        // One bot Telegram refused is said, and costs the other nothing.
        expect(warnings).toEqual(["telegram: the wake webhook was not set, so messages sent while the sandbox sleeps wait until it is opened"]);
    });

    test("a sandbox with no wake URL to hand out points no bot anywhere", async () => {
        const parked = memoryDocument();
        const { log, warnings } = logged();
        const first = bot(TOKEN);
        await wakeWebhooks({ parked, wakeUrl: async () => { throw new Error("this sandbox has no public address"); }, log }).park([first]);
        expect(first.calls).toEqual([]);
        expect(parked.stored()).toEqual({});
        expect(warnings).toEqual(["telegram: no wake URL, so messages sent while the sandbox sleeps wait until it is opened"]);
    });

    test("the polls stop before any bot is pointed at the door, and nothing opens again until the sleep has had its time", async () => {
        const order: string[] = [];
        let told: ((notice: { readonly deadline: number }) => Promise<void> | void) | undefined;
        const sleep = {
            beforeSleep: (handler: NonNullable<typeof told>) => {
                told = handler;
                return { dispose: () => undefined };
            },
        };
        const park = async (bots: readonly { readonly botToken: string }[]): Promise<void> => void order.push(...bots.map(({ botToken }) => `park ${botToken}`));
        const asleep = parkBeforeSleep(sleep, { park }, { bots: () => [bot(TOKEN), bot(OTHER)], close: (botToken) => void order.push(`close ${botToken}`) }, 50);
        expect(asleep()).toBe(false);
        await told?.({ deadline: Date.now() });
        expect(order).toEqual([`close ${TOKEN}`, `close ${OTHER}`, `park ${TOKEN}`, `park ${OTHER}`]);
        expect(asleep()).toBe(true);
        // Still awake well past the deadline: the sleep never came, so the gateway polls again (and clears the webhook).
        await waitFor(() => expect(asleep()).toBe(false));
    });
});

describe("before a bot's first poll", () => {
    const webhookAt = (url: string) => ({ getWebhookInfo: () => ({ url, pending_update_count: 3 }) });

    test("a bot never pointed at the door is asked nothing", async () => {
        const first = bot(TOKEN, webhookAt(WAKE_URL));
        expect(await wakeWebhooks({ parked: memoryDocument(), wakeUrl: async () => WAKE_URL, ...logged() }).reclaim(TOKEN, first.call, false)).toBe(false);
        expect(first.calls).toEqual([]);
    });

    test("this sandbox's own webhook is deleted, keeping what Telegram queued, and the queue is polled", async () => {
        const parked = memoryDocument({ "123456789": DOOR });
        // The wake secret in the query may since have been minted again: the door is what makes it this sandbox's.
        const first = bot(TOKEN, webhookAt(`${DOOR}?wake=minted-again`));
        expect(await wakeWebhooks({ parked, wakeUrl: async () => WAKE_URL, ...logged() }).reclaim(TOKEN, first.call, false)).toBe(true);
        expect(first.calls).toEqual([
            { method: "getWebhookInfo", body: undefined },
            { method: "deleteWebhook", body: { drop_pending_updates: false } },
        ]);
        expect(parked.stored()).toEqual({});
    });

    test("someone else's webhook is never cleared, and the start goes on as it always did", async () => {
        const parked = memoryDocument({ "123456789": DOOR });
        const first = bot(TOKEN, webhookAt("https://hooks.example.com/telegram"));
        expect(await wakeWebhooks({ parked, wakeUrl: async () => WAKE_URL, ...logged() }).reclaim(TOKEN, first.call, false)).toBe(false);
        expect(first.calls).toEqual([{ method: "getWebhookInfo", body: undefined }]);
        expect(parked.stored()).toEqual({});
    });

    test("a webhook already gone still polls the queue the bot slept with", async () => {
        const parked = memoryDocument({ "123456789": DOOR });
        const first = bot(TOKEN, webhookAt(""));
        expect(await wakeWebhooks({ parked, wakeUrl: async () => WAKE_URL, ...logged() }).reclaim(TOKEN, first.call, false)).toBe(true);
        expect(first.calls).toEqual([{ method: "getWebhookInfo", body: undefined }]);
    });

    test("a poll refused 409 by this sandbox's own webhook clears it even with nothing written down; anyone else's stays", async () => {
        const ours = bot(TOKEN, webhookAt(WAKE_URL));
        expect(await wakeWebhooks({ parked: memoryDocument(), wakeUrl: async () => WAKE_URL, ...logged() }).reclaim(TOKEN, ours.call, true)).toBe(true);
        expect(ours.calls.map(({ method }) => method)).toEqual(["getWebhookInfo", "deleteWebhook"]);

        const theirs = bot(TOKEN, webhookAt("https://hooks.example.com/telegram"));
        expect(await wakeWebhooks({ parked: memoryDocument(), wakeUrl: async () => WAKE_URL, ...logged() }).reclaim(TOKEN, theirs.call, true)).toBe(false);
        expect(theirs.calls.map(({ method }) => method)).toEqual(["getWebhookInfo"]);

        // A sandbox with no wake URL (on somebody's own computer) has no door of its own, so the 409 is what it was.
        const unhosted = bot(TOKEN, webhookAt(WAKE_URL));
        const wake = wakeWebhooks({ parked: memoryDocument(), wakeUrl: async () => { throw new Error("no public address"); }, ...logged() });
        expect(await wake.reclaim(TOKEN, unhosted.call, true)).toBe(false);
        expect(unhosted.calls).toEqual([]);
    });
});
