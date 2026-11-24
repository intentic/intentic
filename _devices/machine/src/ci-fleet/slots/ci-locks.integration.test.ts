import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeSys, tempDir } from "../ci-fleet-testing.js";
import { fdinfoFlocked, flockedFiles, lockedSlots, slotFileKeys } from "./ci-locks.js";

/* Reading who holds a slot without taking a lock: /proc/locks by device and inode, the fdinfo of open slot files where
   /proc/locks leaves a lock out, and nothing counted for a waiter or a lock of another kind. */

const PROC_LOCKS = `1: FLOCK  ADVISORY  WRITE 2008618 00:25:1022361 0 EOF
2: POSIX  ADVISORY  WRITE 1104207 00:25:1022362 1073741824 1073742335
3: FLOCK  ADVISORY  WRITE 0 103:10b:77 0 EOF
3: -> FLOCK  ADVISORY  WRITE 4242 00:25:1022363 0 EOF
4: OFDLCK ADVISORY  READ  -1 00:25:1022364 0 EOF
`;

test("/proc/locks gives the files that carry a flock now, device numbers read as hex", () => {
    expect([...flockedFiles(PROC_LOCKS)]).toEqual(["0:37:1022361", "259:267:77"]);
    expect(flockedFiles("")).toEqual(new Set());
});

test("an fdinfo carrying a flock is told from one that carries none or another kind", () => {
    expect(fdinfoFlocked("pos:\t0\nflags:\t0102001\nmnt_id:\t408\nino:\t1782\nlock:\t1: FLOCK  ADVISORY  WRITE 0 00:74:1782 0 EOF\n")).toBe(true);
    expect(fdinfoFlocked("pos:\t0\nflags:\t0102001\nmnt_id:\t408\nino:\t1782\n")).toBe(false);
    expect(fdinfoFlocked("lock:\t1: POSIX  ADVISORY  WRITE 9 00:74:1782 0 EOF\n")).toBe(false);
});

const slotsDir = async (count: number): Promise<string> => {
    const dir = tempDir("ci-slots-keys-");
    for (let slot = 1; slot <= count; slot += 1) {
        // a handful of empty files
        await writeFile(join(dir, `slot-${slot}`), "");
    }
    return dir;
};

const procLine = async (path: string): Promise<string> => {
    const info = await stat(path, { bigint: true });
    // Linux stores the low eight minor bits below the major and the remaining twelve above it.
    const major = Number(info.dev >> 8n) & 0xfff;
    const minor = Number((info.dev & 0xffn) | ((info.dev >> 12n) & 0xfff00n));
    return `9: FLOCK  ADVISORY  WRITE 1 ${major.toString(16).padStart(2, "0")}:${minor.toString(16).padStart(2, "0")}:${info.ino} 0 EOF\n`;
};

test("the slot files are named by the key /proc/locks uses, and a missing one is left out", async () => {
    const dir = await slotsDir(3);
    const keys = await slotFileKeys(dir, 4);
    expect([...keys.values()]).toEqual([1, 2, 3]);
    expect(flockedFiles(await procLine(join(dir, "slot-2")))).toEqual(new Set([...keys].filter(([, slot]) => slot === 2).map(([key]) => key)));
});

test("held slots are joined from /proc/locks and from open descriptors, the rest of the computer ignored", async () => {
    const dir = await slotsDir(4);
    const sys = fakeSys({
        files: new Map([
            ["/proc/locks", `${await procLine(join(dir, "slot-1"))}1: FLOCK  ADVISORY  WRITE 1 00:01:5 0 EOF\n`],
            ["/proc/77/fdinfo/9", "pos:\t0\nlock:\t1: FLOCK  ADVISORY  WRITE 0 00:74:1 0 EOF\n"],
            ["/proc/77/fdinfo/10", "pos:\t0\n"],
            ["/proc/78/fdinfo/3", "lock:\t1: FLOCK  ADVISORY  WRITE 0 00:74:9 0 EOF\n"],
        ]),
        dirs: new Map([
            ["/proc", ["77", "78", "self", "locks"]],
            ["/proc/77/fd", ["9", "10"]],
            ["/proc/78/fd", ["3"]],
        ]),
        links: new Map([
            ["/proc/77/fd/9", join(dir, "slot-3")],
            ["/proc/77/fd/10", join(dir, "slot-4")],
            ["/proc/78/fd/3", "/var/lib/something-else"],
        ]),
    });
    expect([...(await lockedSlots(sys, dir, 4))].toSorted()).toEqual([1, 3]);
});
