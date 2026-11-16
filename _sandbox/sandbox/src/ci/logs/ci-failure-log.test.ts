import { type Logger, pino } from "pino";
import { createCiFailureLog } from "./ci-failure-log.js";
import { refusedFetchError } from "@intentic/testing/real-failures";
import { CiRateLimited, CiRefused } from "../forge-refusals.js";

const capturing = (): { logger: Logger; lines: Record<string, unknown>[] } => {
    const lines: Record<string, unknown>[] = [];
    const logger: Logger = pino({ level: "debug", messageKey: "message" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    return { logger, lines };
};

const refused = (): Error => new CiRefused("list runs of acme/web", 401, "Bad credentials");

test("the same refusal every pass is one line, with its status and no stack, until it changes", () => {
    const { logger, lines } = capturing();
    const log = createCiFailureLog(logger, "ci: poll failed", "ci: poll works again", () => 0);
    for (let pass = 0; pass < 5; pass += 1) {
        log.failed("web", refused());
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, repo: "web", status: 401, message: "ci: poll failed" });
    expect(lines[0]?.["err"]).toBeUndefined();
    // A different failure is news at once.
    log.failed("web", new CiRefused("list runs of acme/web", 502, "Bad gateway"));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ status: 502 });
});

test("another repo's failure is its own line", () => {
    const { logger, lines } = capturing();
    const log = createCiFailureLog(logger, "ci: poll failed", "ci: poll works again", () => 0);
    log.failed("web", refused());
    log.failed("api", refused());
    expect(lines.map((line) => line["repo"])).toEqual(["web", "api"]);
});

test("a long outage stays one line, and recovery is one line with the count it folded", () => {
    const { logger, lines } = capturing();
    const clock = { at: 0 };
    const log = createCiFailureLog(logger, "ci: poll failed", "ci: poll works again", () => clock.at);
    log.failed("web", refused());
    clock.at += 60_000;
    log.failed("web", refused());
    clock.at += 60 * 60_000;
    log.failed("web", refused());
    expect(lines).toHaveLength(1);
    log.succeeded("web");
    log.succeeded("web");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ level: 30, repo: "web", after: "401", repeated: 2, message: "ci: poll works again" });
});

test("a loop that asks first backs off a network failure, and a 401 waits for the token to change", async () => {
    const { logger, lines } = capturing();
    const clock = { at: 0 };
    const log = createCiFailureLog(logger, "ci: runs backfill failed", "ci: runs backfill works again", () => clock.at);
    log.failed("registry", await refusedFetchError(), "t1");
    expect(log.due("registry", "t1")).toBe(false);
    clock.at += 2 * 60 * 60_000;
    expect(log.due("registry", "t1")).toBe(true);
    log.failed("registry", refused(), "t1");
    clock.at += 24 * 60 * 60_000;
    expect(log.due("registry", "t1")).toBe(false);
    expect(log.due("registry", "t2")).toBe(true);
    expect(lines[1]).toMatchObject({ status: 401, retryAt: "when the token or the mapping changes" });
});

test("a network failure or a spent limit is said in words; only an unexpected error keeps its stack", async () => {
    const { logger, lines } = capturing();
    const log = createCiFailureLog(logger, "ci: poll failed", "ci: poll works again", () => 0);
    const network = await refusedFetchError();
    log.failed("a", network);
    log.failed("b", new CiRateLimited("api.github.com", 0));
    log.failed("c", new TypeError("Cannot read properties of undefined (reading 'id')"));
    expect(lines.map((line) => [line["repo"], line["err"] !== undefined])).toEqual([
        ["a", false],
        ["b", false],
        ["c", true],
    ]);
    expect(lines[0]).toMatchObject({ reason: network.message });
});
