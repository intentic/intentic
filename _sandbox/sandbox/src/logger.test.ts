import { type Logger, pino } from "pino";
import { inLogContext, logContext, loggerOptions } from "./logger.js";

const capturing = (): { logger: Logger; lines: Record<string, unknown>[] } => {
    const lines: Record<string, unknown>[] = [];
    const logger: Logger = pino(loggerOptions({ logLevel: "info" }), { write: (line: string) => lines.push(JSON.parse(line)) });
    return { logger, lines };
};

test("a line written inside a request or turn names it under ctx, and one written outside carries no ctx", async () => {
    const { logger, lines } = capturing();

    logger.info("outside");
    await logContext.run({ requestId: "req-1" }, async () => {
        await Promise.resolve();
        logger.info("inside");
    });

    expect(lines.map((line) => [line["message"], line["ctx"]])).toEqual([
        ["outside", undefined],
        ["inside", { requestId: "req-1" }],
    ]);
});

test("every step of a wrapped generator runs in its context, whoever pulls it", async () => {
    const { logger, lines } = capturing();
    async function* turn(): AsyncGenerator<number> {
        logger.info("first");
        yield 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        logger.info("second");
        yield 2;
    }

    const seen: number[] = [];
    await logContext.run({ requestId: "the-puller" }, async () => {
        for await (const value of inLogContext({ conversationId: "calm-reef-a1b2" }, turn())) {
            seen.push(value);
        }
    });

    expect(seen).toEqual([1, 2]);
    expect(lines.map((line) => line["ctx"])).toEqual([{ conversationId: "calm-reef-a1b2" }, { conversationId: "calm-reef-a1b2" }]);
});

test("leaving a wrapped generator early still runs its cleanup inside the context", async () => {
    const { logger, lines } = capturing();
    async function* turn(): AsyncGenerator<number> {
        try {
            yield 1;
            yield 2;
        } finally {
            logger.info("released");
        }
    }

    for await (const value of inLogContext({ conversationId: "calm-reef-a1b2" }, turn())) {
        if (value === 1) {
            break;
        }
    }

    expect(lines).toMatchObject([{ message: "released", ctx: { conversationId: "calm-reef-a1b2" } }]);
});
