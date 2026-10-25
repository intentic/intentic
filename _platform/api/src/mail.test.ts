import { pino } from "pino";
import { configSchema } from "./config.js";
import { sendMail } from "./mail.js";

const config = configSchema.parse({
    database: { url: "postgres://test" },
    betterAuth: { secret: "test" },
    webOrigin: "https://app.test",
    email: { apiKey: "mail-key", from: "sender@example.test" },
});
const logger = pino({ level: "silent" });
const mail = { to: "recipient@example.test", subject: "Test", html: "<p>Test</p>", link: "https://app.test/invite" };

afterEach(() => jest.restoreAllMocks());

test("a successful mail consumes the response and carries a deadline", async () => {
    const response = Response.json({ id: "mail-1" });
    let sentSignal: AbortSignal | null | undefined;
    const call = jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
        sentSignal = init?.signal;
        return response;
    }, { preconnect: fetch.preconnect }));
    expect(await sendMail(config, logger, mail)).toBe("sent");
    expect(sentSignal).toBeInstanceOf(AbortSignal);
    expect(response.bodyUsed).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
});

test("a refusal cannot paste a whole upstream error page into logs", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(20_000), { status: 503 }));
    const error: unknown = await sendMail(config, logger, mail).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: `Resend rejected the email (503): ${"x".repeat(300)}…` });
});

test("a passed deadline aborts a mail request without reporting it as sent", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("mail timed out", "TimeoutError")));
    jest.spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return Response.json({ id: "mail-1" });
    }, { preconnect: fetch.preconnect }));
    await expect(sendMail(config, logger, mail)).rejects.toMatchObject({ name: "TimeoutError", message: "mail timed out" });
    expect(timeout).toHaveBeenCalledWith(30_000);
});

test("a successful status with a malformed acknowledgement is still a sent mail", async () => {
    const response = new Response("not JSON");
    jest.spyOn(globalThis, "fetch").mockResolvedValue(response);
    expect(await sendMail(config, logger, mail)).toBe("sent");
    expect(response.bodyUsed).toBe(true);
});
