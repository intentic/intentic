import {
    cacheDropDistro,
    decodeWslListing,
    DROP_COOLDOWN_MS,
    dropLine,
    EARLY_DROP_COOLDOWN_MS,
    lowSpellSince,
    MAX_DROP_COOLDOWN_MS,
    nextDropCooldown,
    RECLAIM_GRACE_MS,
    recoveredFromTight,
    runningDistrosFrom,
    shouldDropCache,
    WORTHWHILE_DROP_BYTES,
} from "./windows-memory.js";

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
    expect(shouldDropCache({ availableBytes: 6.5 * GIB, totalBytes: 32 * GIB }, NEVER, NOW)).toBe(false);
});

// marta on 2026-11-22: 4.5 GiB of 31.4 for hours, above the low line, with 5 GiB of the VM's cache Windows never got back.
test("a PC under a fifth of its memory gives the cache back early, at a slower pace than one under the low line", () => {
    const tight = { availableBytes: 4.5 * GIB, totalBytes: 31.4 * GIB };
    expect(shouldDropCache(tight, NEVER, NOW)).toBe(true);
    expect(shouldDropCache(tight, NOW - DROP_COOLDOWN_MS, NOW)).toBe(false);
    expect(shouldDropCache(tight, NOW - EARLY_DROP_COOLDOWN_MS + 1, NOW)).toBe(false);
    expect(shouldDropCache(tight, NOW - EARLY_DROP_COOLDOWN_MS, NOW)).toBe(true);
    // Under the low line, the short cooldown still holds however recent the early drop was.
    expect(shouldDropCache({ availableBytes: 2 * GIB, totalBytes: 31.4 * GIB }, NOW - DROP_COOLDOWN_MS, NOW)).toBe(true);
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
    // Intentic's own engine distro is an engine's too: the user's distro first, and it when it is the only one up.
    expect(cacheDropDistro(["intentic-engine", "archlinux"])).toBe("archlinux");
    expect(cacheDropDistro(["intentic-engine"])).toBe("intentic-engine");
    expect(cacheDropDistro(["docker-desktop-data"])).toBeUndefined();
    expect(cacheDropDistro([])).toBeUndefined();
});

test("the log line says what Windows had before and after", () => {
    expect(dropLine("Ubuntu", { availableBytes: 1.1 * GIB, totalBytes: 32 * GIB }, { availableBytes: 7.4 * GIB, totalBytes: 32 * GIB }, 5_000)).toBe(
        "Windows was low on memory (1.1 GiB of 32.0 GiB available): dropped the WSL VM's file cache through Ubuntu; 7.4 GiB available 5s later.",
    );
    expect(dropLine("archlinux", { availableBytes: 2.4 * GIB, totalBytes: 31.4 * GIB }, { availableBytes: 2.6 * GIB, totalBytes: 31.4 * GIB }, 5_000, 20 * 60_000)).toBe(
        "Windows was low on memory (2.4 GiB of 31.4 GiB available): dropped the WSL VM's file cache through archlinux; 2.6 GiB available 5s later. It gave back little, so the next drop waits 20 min unless Windows falls under 1.5 GiB.",
    );
});

// rog on 2026-11-24: 287 drops in 39 hours, five minutes apart, a median 0.2 GiB back each.
test("a drop that gave back little doubles the wait up to an hour, one that gave back half a gigabyte resets it", () => {
    expect(nextDropCooldown(DROP_COOLDOWN_MS, 0.2 * GIB)).toBe(10 * 60_000);
    expect(nextDropCooldown(40 * 60_000, 0.2 * GIB)).toBe(MAX_DROP_COOLDOWN_MS);
    expect(nextDropCooldown(MAX_DROP_COOLDOWN_MS, -0.3 * GIB)).toBe(MAX_DROP_COOLDOWN_MS);
    expect(nextDropCooldown(MAX_DROP_COOLDOWN_MS, WORTHWHILE_DROP_BYTES)).toBe(DROP_COOLDOWN_MS);
    // A failed drop, or one Windows could not be read after, leaves the wait as it was.
    expect(nextDropCooldown(20 * 60_000, undefined)).toBe(20 * 60_000);
});

test("a backed-off wait holds under the low line and above it, never under the 1.5 GiB floor", () => {
    const backedOff = 40 * 60_000;
    const lowLine = { availableBytes: 2.5 * GIB, totalBytes: 31.4 * GIB };
    expect(shouldDropCache(lowLine, NOW - DROP_COOLDOWN_MS, NOW, backedOff)).toBe(false);
    expect(shouldDropCache(lowLine, NOW - backedOff, NOW, backedOff)).toBe(true);
    // Tight but over the low line: the longer of the two waits.
    const tight = { availableBytes: 4.5 * GIB, totalBytes: 31.4 * GIB };
    expect(shouldDropCache(tight, NOW - EARLY_DROP_COOLDOWN_MS, NOW, backedOff)).toBe(false);
    expect(shouldDropCache(tight, NOW - backedOff, NOW, backedOff)).toBe(true);
    // rog froze at 1.1 GB: there five minutes is the wait however little the last drop gave.
    expect(shouldDropCache({ availableBytes: 1.4 * GIB, totalBytes: 31.4 * GIB }, NOW - DROP_COOLDOWN_MS, NOW, MAX_DROP_COOLDOWN_MS)).toBe(true);
});

test("Windows over a fifth of its memory has recovered; at a fifth or under it has not", () => {
    expect(recoveredFromTight({ availableBytes: 6.3 * GIB, totalBytes: 31.4 * GIB })).toBe(true);
    expect(recoveredFromTight({ availableBytes: 6.2 * GIB, totalBytes: 31.4 * GIB })).toBe(false);
});

// (2026-11-26) Above the floor, sandboxes' cgroup reclaim runs first; the blanket drop waits RECLAIM_GRACE_MS.
test("above the floor, the blanket drop waits for sandboxes to reclaim from their own cgroups", () => {
    const underLow = { availableBytes: 2.5 * GIB, totalBytes: 31.4 * GIB };
    const lowSince = NOW - 10_000;
    // Within the grace period: no drop even with the cooldown passed.
    expect(shouldDropCache(underLow, NEVER, NOW, DROP_COOLDOWN_MS, lowSince)).toBe(false);
    // Grace period expired: drop runs.
    const longAgo = NOW - RECLAIM_GRACE_MS;
    expect(shouldDropCache(underLow, NEVER, NOW, DROP_COOLDOWN_MS, longAgo)).toBe(true);
});

test("under the 1.5 GiB floor, the blanket drop runs immediately regardless of grace period", () => {
    const underFloor = { availableBytes: 1.0 * GIB, totalBytes: 31.4 * GIB };
    const lowSince = NOW - 1_000;
    // Under the floor: drops even within the grace period.
    expect(shouldDropCache(underFloor, NEVER, NOW, DROP_COOLDOWN_MS, lowSince)).toBe(true);
});

test("without lowSince (no tracking), the blanket drop runs as before", () => {
    const underLow = { availableBytes: 2.5 * GIB, totalBytes: 31.4 * GIB };
    // No lowSince: same as the old behaviour, respects only cooldown.
    expect(shouldDropCache(underLow, NEVER, NOW)).toBe(true);
    expect(shouldDropCache(underLow, NEVER, NOW, DROP_COOLDOWN_MS, undefined)).toBe(true);
});

test("a low spell begins the first time Windows is under its line, holds while it stays tight, and ends over a fifth", () => {
    const at = (availableGib: number) => ({ availableBytes: availableGib * GIB, totalBytes: 31.4 * GIB });
    // Over the low line (3.14 GiB here) but under a fifth: no spell starts, one already running holds.
    expect(lowSpellSince(at(5), undefined, 1_000)).toBeUndefined();
    expect(lowSpellSince(at(5), 500, 1_000)).toBe(500);
    // Under the line: a spell starts now, or keeps its start.
    expect(lowSpellSince(at(2), undefined, 1_000)).toBe(1_000);
    expect(lowSpellSince(at(2), 500, 1_000)).toBe(500);
    // Over a fifth of the machine: the spell is over.
    expect(lowSpellSince(at(7), 500, 1_000)).toBeUndefined();
});
