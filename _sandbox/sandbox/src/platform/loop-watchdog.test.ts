import { expect, test } from "vitest";
import { parseDnsSocketInodes, parsePressure } from "./loop-watchdog.js";

// Real /proc/pressure shapes: memory/io carry both lines, cpu carries only `some` (a runnable task always
// progresses on something), and a kernel without PSI serves nothing parseable.

test("parses some+full avg10 from a pressure file", () => {
    const text = ["some avg10=1.50 avg60=0.12 avg300=0.08 total=659900661", "full avg10=0.75 avg60=0.12 avg300=0.08 total=572106466"].join("\n");
    expect(parsePressure(text)).toEqual({ some: 1.5, full: 0.75 });
});

test("cpu pressure has no full line — reported as 0, not absent", () => {
    expect(parsePressure("some avg10=2.25 avg60=0.00 avg300=0.10 total=3286364632\n")).toEqual({ some: 2.25, full: 0 });
});

test("unparseable content is undefined, never a throw", () => {
    expect(parsePressure("")).toBeUndefined();
    expect(parsePressure("not a pressure file")).toBeUndefined();
});

// Real /proc/net/udp rows, captured in the container. The remote column is little-endian hex, so Docker's
// embedded resolver at 127.0.0.11:53 reads as `0B00007F:0035` — that row is a lookup still awaiting an answer.
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

test("a table with no lookup open yields nothing — the quiet case must not read as a DNS stall", () => {
    const idle = UDP_TABLE.split("\n")
        .filter((line) => !line.includes(":0035"))
        .join("\n");
    expect(parseDnsSocketInodes(idle)).toEqual([]);
    expect(parseDnsSocketInodes("")).toEqual([]);
});
