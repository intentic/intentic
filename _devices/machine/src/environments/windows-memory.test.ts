import { cacheDropDistro, decodeWslListing, DROP_COOLDOWN_MS, dropLine, runningDistrosFrom, shouldDropCache } from "./windows-memory.js";

const GIB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const NEVER = Number.NEGATIVE_INFINITY;

// The line is 1.5 GiB or a tenth of the machine, whichever is more.
test("a small PC is low under 1.5 GiB, a big one under a tenth of its memory", () => {
    expect(shouldDropCache({ availableBytes: 1.4 * GIB, totalBytes: 8 * GIB }, NEVER, NOW)).toBe(true);
    expect(shouldDropCache({ availableBytes: 1.6 * GIB, totalBytes: 8 * GIB }, NEVER, NOW)).toBe(false);
    // rog on 2026-11-02: 1.1 GB of 32.
    expect(shouldDropCache({ availableBytes: 1.1 * GIB, totalBytes: 32 * GIB }, NEVER, NOW)).toBe(true);
    expect(shouldDropCache({ availableBytes: 3 * GIB, totalBytes: 32 * GIB }, NEVER, NOW)).toBe(true);
    expect(shouldDropCache({ availableBytes: 3.3 * GIB, totalBytes: 32 * GIB }, NEVER, NOW)).toBe(false);
});

test("a drop is not repeated within the cooldown, however low Windows stays", () => {
    const low = { availableBytes: 0.5 * GIB, totalBytes: 16 * GIB };
    expect(shouldDropCache(low, NOW - DROP_COOLDOWN_MS + 1, NOW)).toBe(false);
    expect(shouldDropCache(low, NOW - DROP_COOLDOWN_MS, NOW)).toBe(true);
});

// What wsl.exe prints depends on its build: UTF-16LE from an old one, UTF-8 where WSL_UTF8 is honoured.
test("the running list reads the same in UTF-16LE, with or without a BOM, and in UTF-8", () => {
    const listing = "Ubuntu-22.04\r\ndocker-desktop\r\n";
    const utf16 = Buffer.from(listing, "utf16le");
    expect(runningDistrosFrom(decodeWslListing(utf16))).toEqual(["Ubuntu-22.04", "docker-desktop"]);
    expect(runningDistrosFrom(decodeWslListing(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])))).toEqual(["Ubuntu-22.04", "docker-desktop"]);
    expect(runningDistrosFrom(decodeWslListing(Buffer.from(listing, "utf8")))).toEqual(["Ubuntu-22.04", "docker-desktop"]);
    // A UTF-16 listing mis-decoded upstream still has its NULs, which never belong to a name.
    expect(runningDistrosFrom(Buffer.from("Arch\n", "utf16le").toString("utf8"))).toEqual(["Arch"]);
});

test("a sentence instead of a listing names no distro", () => {
    expect(runningDistrosFrom(decodeWslListing(Buffer.from("There are no running distributions.\r\n", "utf16le")))).toEqual([]);
    expect(runningDistrosFrom("")).toEqual([]);
});

test("the user's own distro is preferred, docker-desktop is the fallback, and nothing running means no drop", () => {
    expect(cacheDropDistro(["docker-desktop", "Ubuntu"])).toBe("Ubuntu");
    expect(cacheDropDistro(["docker-desktop"])).toBe("docker-desktop");
    expect(cacheDropDistro(["docker-desktop-data"])).toBeUndefined();
    expect(cacheDropDistro([])).toBeUndefined();
});

test("the log line says what Windows had before and after", () => {
    expect(dropLine("Ubuntu", { availableBytes: 1.1 * GIB, totalBytes: 32 * GIB }, { availableBytes: 7.4 * GIB, totalBytes: 32 * GIB }, 5_000)).toBe(
        "Windows was low on memory (1.1 GiB of 32.0 GiB available): dropped the WSL VM's file cache through Ubuntu; 7.4 GiB available 5s later.",
    );
});
