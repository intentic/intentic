import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rollOpenLog } from "./log-roll.js";

// The supervisor holds the log open for appending, as every one of them does; the roll must not take its lines away.
test("a log past the limit is set aside and cut in place, and a writer holding it open keeps writing to it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "log-roll-")), "machine.log");
    writeFileSync(path, "x".repeat(64));
    const fd = openSync(path, "a");
    expect(await rollOpenLog(path, 100)).toBe(false);
    writeSync(fd, "y".repeat(64));
    expect(await rollOpenLog(path, 100)).toBe(true);
    expect(readFileSync(`${path}.1`, "utf8")).toBe(`${"x".repeat(64)}${"y".repeat(64)}`);
    writeSync(fd, "after the roll\n");
    closeSync(fd);
    expect(readFileSync(path, "utf8")).toBe("after the roll\n");
    expect(await rollOpenLog(join(path, "..", "missing.log"), 100)).toBe(false);
    expect(existsSync(join(path, "..", "missing.log.1"))).toBe(false);
});
