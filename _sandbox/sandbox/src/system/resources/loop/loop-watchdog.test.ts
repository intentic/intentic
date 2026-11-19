import { parseDnsSocketInodes, pausedFor } from "./loop-watchdog.js";

// Real /proc/net/udp rows, captured in the container. The remote column is little-endian hex, so Docker's
// embedded resolver at 127.0.0.11:53 reads as `0B00007F:0035`: that row is a lookup still awaiting an answer.
const UDP_TABLE = [
    "   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops",
    "12722: 0100007F:EAE0 0B00007F:0035 01 00000000:00000000 00:00000000 00000000     0        0 215512445 2 000000003e3eb337 0",
    " 1854: 00000000:0044 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 211095487 2 0000000000000000 0",
    "12980: 0100007F:B2C1 0B00007F:0035 01 00000000:00000000 00:00000000 00000000     0        0 215512999 2 000000003e3eb338 0",
    "",
].join("\n");

test("picks out the inodes of in-flight DNS queries, skipping the header and non-DNS sockets", () => {
    expect(parseDnsSocketInodes(UDP_TABLE)).toEqual(["215512445", "215512999"]);
});

test("a table with no lookup open yields nothing: the quiet case must not read as a DNS stall", () => {
    const idle = UDP_TABLE.split("\n")
        .filter((line) => !line.includes(":0035"))
        .join("\n");
    expect(parseDnsSocketInodes(idle)).toEqual([]);
    expect(parseDnsSocketInodes("")).toEqual([]);
});

// 2026-11-19: a laptop's lid closed for four hours. Inside its VM the monotonic clock stood still and the wall clock was
// set right on waking, so the tick that saw it came back half a second late by one clock and four hours by the other.
test("a wall clock far ahead of the monotonic one is the machine stopped under the daemon, said as the gap it left", () => {
    const fourHours = 4 * 3_600_000;
    expect(pausedFor(fourHours + 500, 500)).toBe(fourHours);
});

test("ordinary ticks, a stall the monotonic clock saw too, and a clock set back are no pause", () => {
    expect(pausedFor(510, 500)).toBeUndefined();
    expect(pausedFor(30_000, 500)).toBeUndefined();
    expect(pausedFor(90_000, 90_000)).toBeUndefined();
    expect(pausedFor(-3_600_000, 500)).toBeUndefined();
});
