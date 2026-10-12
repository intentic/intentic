import { type Logger, pino } from "pino";
import { createCiFailureLog } from "./ci-failure-log.js";
import { CiRateLimited } from "./providers.js";

const capturing = (): { logger: Logger; lines: Record<string, unknown>[] } => {
    const lines: Record<string, unknown>[] = [];
    const logger: Logger = pino({ level: "debug", messageKey: "message" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    return { logger, lines };
};

const refused = (): Error => new Error("list runs of acme/web failed (401): Bad credentials");

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
    log.failed("web", new Error("list runs of acme/web failed (502): Bad gateway"));
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

test("a long outage repeats hourly with the count it folded, and recovery is one line", () => {
    const { logger, lines } = capturing();
    const clock = { at: 0 };
    const log = createCiFailureLog(logger, "ci: poll failed", "ci: poll works again", () => clock.at);
    log.failed("web", refused());
    clock.at += 60_000;
    log.failed("web", refused());
    clock.at += 60 * 60_000;
    log.failed("web", refused());
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ repeated: 1 });
    log.succeeded("web");
    log.succeeded("web");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ level: 30, repo: "web", after: "401", message: "ci: poll works again" });
});

test("a network failure or a spent limit is said in words; only an unexpected error keeps its stack", () => {
    const { logger, lines } = capturing();
    const log = createCiFailureLog(logger, "ci: poll failed", "ci: poll works again", () => 0);
    log.failed("a", Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
    log.failed("b", new CiRateLimited("api.github.com", 0));
    log.failed("c", new TypeError("Cannot read properties of undefined (reading 'id')"));
    expect(lines.map((line) => [line["repo"], line["err"] !== undefined])).toEqual([
        ["a", false],
        ["b", false],
        ["c", true],
    ]);
    expect(lines[0]).toMatchObject({ reason: "fetch failed" });
});
