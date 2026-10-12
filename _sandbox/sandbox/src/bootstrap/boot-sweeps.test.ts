import { idleSweepLog } from "./boot-sweeps.js";

const recording = () => {
    const lines: { level: string; data: Record<string, unknown>; message: string }[] = [];
    const at = (level: string) => (data: Record<string, unknown>, message: string) => void lines.push({ level, data, message });
    return { lines, logger: { debug: at("debug"), info: at("info"), warn: at("warn") } as never };
};

const errno = (code: string): Error => Object.assign(new Error(`${code}: something`), { code });

test("a server that left mid-sweep is not a failure of the sweep", () => {
    const { lines, logger } = recording();
    const log = idleSweepLog(logger, () => 0);
    log.failed(errno("ESRCH"));
    log.succeeded();
    expect(lines.map((line) => line.level)).toEqual(["debug"]);
});

// The sweep runs every minute: a failure it keeps meeting used to be a stack every minute.
test("a failure every pass is one line, then the count hourly, then one line when a pass goes through", () => {
    const { lines, logger } = recording();
    const clock = { at: 0 };
    const log = idleSweepLog(logger, () => clock.at);
    for (let pass = 0; pass <= 60; pass += 1) {
        log.failed(errno("EACCES"));
        clock.at += 60_000;
    }
    log.succeeded();
    expect(lines.map((line) => [line.level, line.message])).toEqual([
        ["warn", "localmodel idle sweep failed"],
        ["warn", "localmodel idle sweep failed"],
        ["info", "localmodel idle sweep works again"],
    ]);
    expect(lines[1]?.data).toMatchObject({ repeated: 59 });
    expect(lines[2]?.data).toMatchObject({ after: "EACCES", repeated: 0 });
});
