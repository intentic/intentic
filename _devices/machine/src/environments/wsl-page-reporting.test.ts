import {
    adoptHold,
    cmdlineOrder,
    freeBlocksByOrder,
    freeSplit,
    GUEST_PROBE_SCRIPT,
    type GuestProbe,
    guestFreeOf,
    LOW_PROBE_EVERY_MS,
    loweredLine,
    orderScript,
    parseGuestProbe,
    PROBE_EVERY_MS,
    probeDue,
    RESTORE_AFTER_MS,
    restoredLine,
    restoreStep,
    shouldLowerOrder,
    strandedOf,
} from "./wsl-page-reporting.js";

const GIB = 1024 ** 3;
const NOW = 1_800_000_000_000;

// rog on 2026-11-26, read through archlinux with GUEST_PROBE_SCRIPT: Windows at its 3.1 GiB low line, MemFree 3133812 kB.
const ROG_BUDDYINFO = `Node 0, zone    DMA32   8839   4046   2538   1990   1371    849    522    232      1      0      0
Node 0, zone   Normal  40264  26270  17466  13207   8012   3806   1243    164     35      0      0
`;
const ROG_CMDLINE =
    "initrd=\\initrd.img WSL_ROOT_INIT=1 panic=-1 nr_cpus=16 hv_utils.timesync_implicit=1 printk.devkmsg=on page_reporting.page_reporting_order=5 hv_storvsc.storvsc_max_hw_queues=4 console=hvc0 debug pty.legacy_count=0 WSL_ENABLE_CRASH_DUMP=1";
const rogProbe = (order: number): string => `${ROG_BUDDYINFO}--\n${order}\n--\n${ROG_CMDLINE}\n--\n4096\n`;

const parsed = (order: number): GuestProbe => {
    const probe = parseGuestProbe(rogProbe(order));
    if (probe === undefined) {
        throw new Error("rog's probe did not parse");
    }
    return probe;
};

// Pages in blocks under order 5 on rog: DMA32 64 939 and Normal 396 516; over it, 90 528 and 231 296.
const ROG_STRANDED_AT_5 = (64_939 + 396_516) * 4096;
const ROG_REPORTABLE_AT_5 = (90_528 + 231_296) * 4096;
// Under order 2 only single pages and pairs: DMA32 8839 + 2 × 4046, Normal 40 264 + 2 × 26 270.
const ROG_STRANDED_AT_2 = (8839 + 2 * 4046 + 40_264 + 2 * 26_270) * 4096;

test("buddyinfo's free blocks are summed over every zone, order by order", () => {
    expect(freeBlocksByOrder(ROG_BUDDYINFO)).toEqual([49_103, 30_316, 20_004, 15_197, 9383, 4655, 1765, 396, 36, 0, 0]);
    expect(freeBlocksByOrder("")).toEqual([]);
    expect(freeBlocksByOrder("cat: /proc/buddyinfo: No such file or directory")).toEqual([]);
});

test("rog's free memory splits at the reporting order into what Windows gets back and what stays stranded", () => {
    const probe = parsed(5);
    expect(probe).toMatchObject({ order: 5, bootOrder: 5, pageBytes: 4096 });
    expect(freeSplit(probe, 5)).toEqual({ reportableBytes: ROG_REPORTABLE_AT_5, strandedBytes: ROG_STRANDED_AT_5 });
    // 1.76 GiB stranded of 2.99 GiB free, which is the MemFree the guest reported beside it (within its per-CPU lists).
    expect(ROG_STRANDED_AT_5 / GIB).toBeCloseTo(1.76, 2);
    expect(Math.abs(ROG_STRANDED_AT_5 + ROG_REPORTABLE_AT_5 - 3_133_812 * 1024)).toBeLessThan(2 * 1024 ** 2);
    // The same free memory, read at order 2: what lowering it turns reportable without a page moving.
    expect(freeSplit(probe, 2).strandedBytes).toBe(ROG_STRANDED_AT_2);
    expect(strandedOf(parsed(2))).toBe(ROG_STRANDED_AT_2);
});

test("the kernel's boot order is read off its command line, the last one counting", () => {
    expect(cmdlineOrder(ROG_CMDLINE)).toBe(5);
    expect(cmdlineOrder(`${ROG_CMDLINE} page_reporting.page_reporting_order=3`)).toBe(3);
    expect(cmdlineOrder("console=hvc0 xpage_reporting.page_reporting_order=4 debug")).toBeUndefined();
    expect(cmdlineOrder("console=hvc0")).toBeUndefined();
});

test("a guest with no page reporting, or an unreadable answer, reads as nothing", () => {
    expect(parseGuestProbe(`${ROG_BUDDYINFO}--\n\n--\n${ROG_CMDLINE}\n--\n4096\n`)).toBeUndefined();
    expect(parseGuestProbe("")).toBeUndefined();
    expect(parseGuestProbe("--\n5\n--\n--\n")).toBeUndefined();
    // No getconf (a minimal engine distro): pages are 4 KiB. A command line without the order: no boot order.
    expect(parseGuestProbe(`${ROG_BUDDYINFO}--\n5\n--\nconsole=hvc0\n--\n`)).toEqual({ blocks: freeBlocksByOrder(ROG_BUDDYINFO), order: 5, pageBytes: 4096 });
    // wsl.exe from Windows may end lines with CRLF.
    expect(parseGuestProbe(rogProbe(5).replaceAll("\n", "\r\n"))).toMatchObject({ order: 5, bootOrder: 5, pageBytes: 4096 });
});

test("the scripts wsl.exe hands a login shell hold no $ or quote for it to expand", () => {
    for (const script of [GUEST_PROBE_SCRIPT, orderScript(5, 2, true), orderScript(2, 5, false)]) {
        expect(script).not.toMatch(/[$"'`]/);
    }
    expect(orderScript(5, 2, true)).toContain("compact_memory");
    expect(orderScript(2, 5, false)).not.toContain("compact_memory");
});

const lowWindows = { availableBytes: 2.9 * GIB, totalBytes: 31.4 * GIB };
const tightWindows = { availableBytes: 4.5 * GIB, totalBytes: 31.4 * GIB };
const easyWindows = { availableBytes: 8 * GIB, totalBytes: 31.4 * GIB };

test("the order is lowered when Windows is low and more than a gigabyte of the VM's free memory is stranded", () => {
    expect(shouldLowerOrder(lowWindows, parsed(5), undefined, false)).toBe(true);
    // Above the low line, only a due drop (which it stands in for) lowers it.
    expect(shouldLowerOrder(tightWindows, parsed(5), undefined, false)).toBe(false);
    expect(shouldLowerOrder(tightWindows, parsed(5), undefined, true)).toBe(true);
    // Held already, or at the lowered order already: nothing to do.
    expect(shouldLowerOrder(lowWindows, parsed(5), { from: 5 }, true)).toBe(false);
    expect(shouldLowerOrder(lowWindows, parsed(2), undefined, true)).toBe(false);
    // Under a gigabyte stranded is within Windows' own noise.
    const fewStranded = { ...parsed(5), blocks: [1000, 1000, 1000, 1000, 1000, 50_000] };
    expect(strandedOf(fewStranded)).toBeLessThan(GIB);
    expect(shouldLowerOrder(lowWindows, fewStranded, undefined, true)).toBe(false);
});

test("the kernel's order comes back only after Windows has held over a fifth of its memory for ten minutes", () => {
    expect(restoreStep(undefined, easyWindows, NOW)).toEqual({ hold: undefined, restore: false });
    let step = restoreStep({ from: 5 }, easyWindows, NOW);
    expect(step).toEqual({ hold: { from: 5, recoveredSince: NOW }, restore: false });
    step = restoreStep(step.hold, easyWindows, NOW + RESTORE_AFTER_MS - 1);
    expect(step.restore).toBe(false);
    // Under a fifth again, even above the low line, starts the wait over.
    step = restoreStep(step.hold, tightWindows, NOW + RESTORE_AFTER_MS - 1);
    expect(step).toEqual({ hold: { from: 5 }, restore: false });
    step = restoreStep(step.hold, easyWindows, NOW + RESTORE_AFTER_MS);
    expect(step.restore).toBe(false);
    step = restoreStep(step.hold, easyWindows, NOW + 2 * RESTORE_AFTER_MS);
    expect(step).toEqual({ hold: { from: 5, recoveredSince: NOW + RESTORE_AFTER_MS }, restore: true });
});

test("the hold follows the order the guest reads: a restarted VM drops it, an earlier agent's lowered order is adopted", () => {
    // The VM restarted, or someone set it: not the agent's to put back.
    expect(adoptHold({ from: 5 }, parsed(5))).toBeUndefined();
    expect(adoptHold({ from: 5, recoveredSince: NOW }, parsed(2))).toEqual({ from: 5, recoveredSince: NOW });
    // An agent stopped without restoring: the kernel's boot order is what goes back.
    expect(adoptHold(undefined, parsed(2))).toEqual({ from: 5 });
    const { bootOrder: _, ...unbooted } = parsed(2);
    expect(adoptHold(undefined, unbooted)).toBeUndefined();
    expect(adoptHold(undefined, parsed(5))).toBeUndefined();
});

test("the guest is read every minute while Windows is low and the order could still help, every five while tight, never with room", () => {
    const since = (ms: number) => NOW - ms;
    expect(probeDue(lowWindows, NOW, undefined, since(LOW_PROBE_EVERY_MS), NOW)).toBe(true);
    expect(probeDue(lowWindows, NOW, undefined, since(LOW_PROBE_EVERY_MS - 1), NOW)).toBe(false);
    // Held lowered already, or only tight: every five minutes, for the heartbeat's figures.
    expect(probeDue(lowWindows, NOW, { from: 5 }, since(LOW_PROBE_EVERY_MS), NOW)).toBe(false);
    expect(probeDue(lowWindows, NOW, { from: 5 }, since(PROBE_EVERY_MS), NOW)).toBe(true);
    expect(probeDue(tightWindows, undefined, undefined, since(PROBE_EVERY_MS - 1), NOW)).toBe(false);
    expect(probeDue(tightWindows, undefined, undefined, since(PROBE_EVERY_MS), NOW)).toBe(true);
    // A PC with room never spawns wsl.exe for it.
    expect(probeDue(easyWindows, undefined, undefined, Number.NEGATIVE_INFINITY, NOW)).toBe(false);
});

test("the heartbeat's figure says the order it was lowered from only while held", () => {
    expect(guestFreeOf(parsed(5), NOW, undefined)).toEqual({ reportableBytes: ROG_REPORTABLE_AT_5, strandedBytes: ROG_STRANDED_AT_5, reportingOrder: 5, at: NOW });
    expect(guestFreeOf(parsed(2), NOW, { from: 5 })).toMatchObject({ strandedBytes: ROG_STRANDED_AT_2, reportingOrder: 2, loweredFrom: 5 });
});

test("lowering and restoring each leave one line with the stranded memory and Windows before and after", () => {
    expect(
        loweredLine("archlinux", 5, { windows: lowWindows, strandedBytes: 2.03 * GIB }, { windows: { ...lowWindows, availableBytes: 3.6 * GIB }, strandedBytes: 0.22 * GIB }, 5000),
    ).toBe(
        "Windows was low on memory (2.9 GiB of 31.4 GiB available) while the WSL VM had 2.0 GiB free in blocks too small to give back (page_reporting_order 5): lowered it to 2 and compacted through archlinux; 0.2 GiB stranded and 3.6 GiB available 5s later.",
    );
    expect(restoredLine("archlinux", 5, "recovered", { windows: easyWindows, strandedBytes: 0.3 * GIB }, { windows: easyWindows, strandedBytes: 1.1 * GIB }, 5000)).toBe(
        "Windows has had more than a fifth of its memory for 10 min (8.0 GiB of 31.4 GiB available): put the WSL VM's page_reporting_order back from 2 to 5 through archlinux (0.3 GiB stranded before); 1.1 GiB stranded and 8.0 GiB available 5s later.",
    );
    expect(restoredLine("archlinux", 5, "stopping", { windows: lowWindows, strandedBytes: undefined })).toBe(
        "the agent is stopping: put the WSL VM's page_reporting_order back from 2 to 5 through archlinux (an unread amount stranded before).",
    );
});
