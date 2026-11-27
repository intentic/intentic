import { waitFor } from "@intentic/testing/bun";
import { closeTelegramConnection, FatalTelegramError, openTelegramConnection } from "./client.js";

// Where a connection's polling starts, with the Bot API stood in for at `fetch`: from now, as ever, unless the bot slept
// pointed at the sandbox's wake door, when Telegram's queue is what arrived meanwhile; and a 409 at start is fatal only
// when the webhook behind it is not this sandbox's own.

const TOKEN = "123456789:AAH-first-secret-part";

interface Called {
    readonly method: string;
    readonly body: Record<string, unknown>;
}

const ok = (result: unknown): Response => Response.json({ ok: true, result });
const refused = (code: number, description: string): Response => Response.json({ ok: false, error_code: code, description });

// The Bot API: an answer per method, `getMe` a bot with a username by default, and a long poll held until it is aborted.
const telegram = (answers: Readonly<Record<string, (body: Record<string, unknown>) => Response>> = {}): Called[] => {
    const calls: Called[] = [];
    jest.spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                const method = String(url).split("/").at(-1) ?? "";
                // SAFETY: the client sends every Bot API call as a JSON object.
                const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
                calls.push({ method, body });
                if (method === "getUpdates" && body["timeout"] !== 0) {
                    return new Promise<Response>((_resolve, reject) => {
                        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
                    });
                }
                const answer = answers[method] ?? (method === "getMe" ? () => ok({ id: 123456789, is_bot: true, username: "acme_bot" }) : () => ok(true));
                return answer(body);
            },
            { preconnect: fetch.preconnect },
        ),
    );
    return calls;
};

// The first long poll the loop sends, once it is listening.
const firstPoll = async (calls: readonly Called[]): Promise<Record<string, unknown>> => {
    await waitFor(() => expect(calls.some(({ method, body }) => method === "getUpdates" && body["timeout"] === 50)).toBe(true));
    return calls.find(({ method, body }) => method === "getUpdates" && body["timeout"] === 50)?.body ?? {};
};

afterEach(() => {
    closeTelegramConnection(TOKEN);
    jest.restoreAllMocks();
});

test("a start skips what Telegram held before it, as it always did", async () => {
    const calls = telegram({ getUpdates: () => ok([{ update_id: 41 }]) });
    const connection = await openTelegramConnection(TOKEN, { reclaim: async () => false });
    connection.listen(
        () => undefined,
        () => undefined,
        () => undefined,
    );
    expect(await firstPoll(calls)).toMatchObject({ offset: 42 });
});

test("a bot that slept pointed at the wake door polls Telegram's queue, what arrived while the sandbox slept", async () => {
    const calls = telegram();
    const asked: boolean[] = [];
    const connection = await openTelegramConnection(TOKEN, {
        reclaim: async (_call, conflict) => {
            asked.push(conflict);
            return true;
        },
    });
    connection.listen(
        () => undefined,
        () => undefined,
        () => undefined,
    );
    const poll = await firstPoll(calls);
    expect(asked).toEqual([false]);
    // No tail read and no offset: the first poll starts at the oldest update Telegram kept.
    expect(calls.filter(({ method }) => method === "getUpdates")).toHaveLength(1);
    expect(poll).not.toHaveProperty("offset");
});

test("a 409 from this sandbox's own webhook is no other reader: it is cleared and the queue polled", async () => {
    const calls = telegram({ getUpdates: () => refused(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first") });
    const asked: boolean[] = [];
    const connection = await openTelegramConnection(TOKEN, {
        reclaim: async (_call, conflict) => {
            asked.push(conflict);
            return conflict;
        },
    });
    expect(asked).toEqual([false, true]);
    expect(connection.username).toBe("acme_bot");
    expect(calls.map(({ method }) => method)).toEqual(["getMe", "getUpdates"]);
});

test("a 409 from anyone else's webhook stays fatal, naming the fix", async () => {
    telegram({ getUpdates: () => refused(409, "Conflict: can't use getUpdates method while webhook is active") });
    const opening = openTelegramConnection(TOKEN, { reclaim: async () => false });
    expect(await opening.catch((error: Error) => error)).toBeInstanceOf(FatalTelegramError);
    await expect(opening).rejects.toThrow(/Another reader is already receiving this bot's updates/u);
});
