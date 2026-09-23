import { parseDnsSocketInodes } from "./loop-watchdog.js";

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
