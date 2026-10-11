import { anyConnected, establishedPortsIn } from "./established.js";

// Two rows of /proc/net/tcp as the kernel writes them: a listener on 4321 (st 0A) and a browser's connection to it (01).
const TABLE = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:10E1 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 123 1 0000000000000000 100 0 0 10 0
   1: 0100007F:10E1 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000     0        0 124 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:D2F0 0100007F:10E1 01 00000000:00000000 00:00000000 00000000     0        0 125 1 0000000000000000 20 4 30 10 -1`;

describe("established connections", () => {
    test("names the local port of every established row, never a listener's", () => {
        // 4321 is the server's side of the connection, 54000 the client's.
        expect([...establishedPortsIn(TABLE)].toSorted((a, b) => a - b)).toEqual([4321, 54000]);
    });

    test("a port is in use while a connection to it is open, and a missing table counts as none", async () => {
        const noIpv6 = Object.assign(new Error("no ipv6"), { code: "ENOENT" });
        const read = (path: string): Promise<string> => (path.endsWith("tcp") ? Promise.resolve(TABLE) : Promise.reject(noIpv6));
        expect(await anyConnected([4321], read)).toBe(true);
        expect(await anyConnected([5173], read)).toBe(false);
        expect(await anyConnected([], read)).toBe(false);
    });

    test("a table that is there but cannot be read is no answer, not a quiet one", async () => {
        const refused = Object.assign(new Error("permission denied"), { code: "EACCES" });
        const read = (path: string): Promise<string> => (path.endsWith("tcp") ? Promise.resolve(TABLE) : Promise.reject(refused));
        await expect(anyConnected([5173], read)).rejects.toBe(refused);
    });
});
