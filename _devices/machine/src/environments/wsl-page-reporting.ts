import { type GuestFreeMemory, type HostMemory, hostMemoryLowBytes } from "@intentic/sandbox-contract/schemas/hosts";
import { recoveredFromTight } from "./windows-memory.js";

/* FREE MEMORY THE WSL2 VM CANNOT GIVE BACK, AND THE ORDER THAT DECIDES IT (2026-11-26). The VM hands free memory back to
   Windows through free page reporting, which reports only free blocks of at least 2^page_reporting_order pages. WSL
   boots its kernel with `page_reporting.page_reporting_order=5` (128 KiB blocks); the parameter is writable at runtime
   as root. Free memory in smaller blocks stays charged to Windows as the VM's.

   Measured on rog (31.4 GiB, the VM given 22 GB) that day, from /proc/buddyinfo beside vmmemWSL and Windows' Available
   memory: 2.0-2.6 GB of the VM's free memory sat in blocks under 128 KiB at most readings, and 5.3 of the 8.4 GB free
   right after a cache drop, which is why drops gave back little. Lowering the order to 2 (16 KiB) took that 2.03 GB down
   to 0.22 GB within 30 s, vmmemWSL's working set from 13.81 to 12.33 GB and Windows' Available from 4.59 to 5.34 GB, and
   compacting after it gave back 0.56 GB more. A sandbox's own 1 GiB `memory.reclaim` freed that much inside the VM but in
   blocks under the order, so Windows did not see it at all. Again that afternoon, with Windows at 1-4 GB: lowering with
   2.7 GB stranded took vmmemWSL's private bytes down 1.6 GB and raised Windows' available by 0.8 GB within 16 s; over
   twelve 1 GiB reclaims, 93% of what each freed sat under 128 KiB and 58% still under 16 KiB (single pages and pairs of
   file cache), so a lowered order lets about two fifths of a reclaim through rather than a fifteenth.

   So when Windows goes under its low line with more than STRANDED_WORTH_BYTES stranded, the agent lowers the order to
   LOWERED_ORDER and compacts once, before or beside the sandboxes' first reclaim, and gives the kernel its own order back
   once Windows has had more than a fifth of its memory for RESTORE_AFTER_MS, and when the agent stops. That is for a VM
   whose memory is backed by large pages on the host, where reporting smaller blocks would split them (TLB misses,
   unmeasured).

   A VM BACKED BY SMALL PAGES KEEPS IT LOWERED (2026-11-26, later). WSL picks the boot order from the host's backing
   (WslCoreVm.cpp in microsoft/WSL): where Windows can back the VM with 4 KiB pages (build 26100 on, and serviced older
   builds) it asks for small-page backing with 64 KiB fault clusters and boots at 5; otherwise it boots at 9, 2 MiB. On a
   small-page VM the lower order changes no host page size; what it costs is the host faulting a reported page back in
   when the guest uses it again. Measured on rog that day (build 26200, booted at 5): re-touching memory after free page
   reporting had taken it cost 1390 ns a 4 KiB page against 1137 for memory that had not been reported (median of 12
   rounds of 32768 pages each), and the same churn over 16 KiB chunks ran 226 ns a page slower at order 2 than at 5.
   rog's VM allocated 25-54 thousand pages a second under its usual load, so even with every page coming from a reported
   block the lower order costs at most 13.5 ms of CPU a second: 0.08% of its 16 vCPUs, for 0.8-2.8 GB that would stay
   stranded otherwise. So on a VM booted at SMALL_PAGE_BOOT_ORDER or lower, the order is lowered whenever Windows is under
   a fifth of its memory (when the guest is read at all) with more than STRANDED_WORTH_BYTES stranded, and held until the
   agent stops rather than until Windows recovers. Pure decisions here; the resident agent acts on them on its tick
   (wsl-guest.ts, beside the drop in wsl-cache-drop.ts). */

const GIB = 1024 ** 3;

const ORDER_PATH = "/sys/module/page_reporting/parameters/page_reporting_order";
// 2^2 pages: 16 KiB blocks. Not lower: every block reported is a hypervisor call, and order 0 would report single pages.
export const LOWERED_ORDER = 2;
// Less stranded than this is not worth more hypervisor work: Windows' own noise is a few hundred MiB.
const STRANDED_WORTH_BYTES = 1 * GIB;
// The highest boot order WSL gives a VM it backs with small pages (5); a large-page VM boots at 9.
const SMALL_PAGE_BOOT_ORDER = 5;
// How long Windows stays over a fifth of its memory before the kernel's order is put back: the gap between the low line
// (a tenth) and a fifth, held this long, keeps a PC hovering at its line from switching the order back and forth.
export const RESTORE_AFTER_MS = 10 * 60_000;
// How often the guest is read while Windows is under a fifth of its memory: every five minutes for the heartbeat's
// figures, every minute while Windows is low and the order is not lowered yet, since that is when stranded memory decides
// what happens.
export const PROBE_EVERY_MS = 5 * 60_000;
export const LOW_PROBE_EVERY_MS = 60_000;

const SECTION = "--";
// One read of the guest, as the distro's own user: no root needed. No `$` and no quote in it, since wsl.exe hands the
// line to the distro's login shell before `sh` sees it (DROP_SCRIPT in wsl-cache-drop.ts goes the same way).
export const GUEST_PROBE_SCRIPT = `cat /proc/buddyinfo; echo ${SECTION}; cat ${ORDER_PATH} 2>/dev/null; echo ${SECTION}; cat /proc/cmdline; echo ${SECTION}; getconf PAGESIZE 2>/dev/null`;

const COMPACT = "if [ -w /proc/sys/vm/compact_memory ]; then echo 1 > /proc/sys/vm/compact_memory; fi";
// Sets the order to `next` only where it still reads `expected` (exit 3 otherwise: someone else changed it, which is
// theirs), then compacts when asked. Run as root.
export const orderScript = (expected: number, next: number, compact: boolean): string =>
    `grep -qx ${expected} ${ORDER_PATH} || exit 3; echo ${next} > ${ORDER_PATH}${compact ? `; ${COMPACT}` : ""}`;

/** The free blocks per order (index 0 is single pages) from /proc/buddyinfo, every zone of every node summed. Pure. */
export const freeBlocksByOrder = (buddyinfo: string): number[] => {
    const totals: number[] = [];
    for (const line of buddyinfo.split(/\r?\n/)) {
        const counts = /^Node\s+\d+,\s*zone\s+\S+\s+(.+)$/.exec(line.trim())?.[1];
        if (counts === undefined) {
            continue;
        }
        counts
            .trim()
            .split(/\s+/)
            .forEach((field, order) => {
                const count = Number(field);
                totals[order] = (totals[order] ?? 0) + (Number.isFinite(count) ? count : 0);
            });
    }
    return totals;
};

/** The order the kernel was booted with (`page_reporting.page_reporting_order=N`, the last one counting), if any. Pure. */
export const cmdlineOrder = (cmdline: string): number | undefined => {
    const orders = [...cmdline.matchAll(/(?:^|\s)page_reporting\.page_reporting_order=(\d+)(?=\s|$)/g)].map((match) => Number(match[1]));
    return orders.at(-1);
};

export interface GuestProbe {
    readonly blocks: readonly number[];
    // page_reporting_order as it reads now.
    readonly order: number;
    // The order the kernel was booted with, from its command line: what an agent that lost its own record restores.
    bootOrder?: number;
    readonly pageBytes: number;
}

const DEFAULT_PAGE_BYTES = 4096;

/** GUEST_PROBE_SCRIPT's output read back; undefined without buddyinfo or an order (a kernel without page reporting). Pure. */
export const parseGuestProbe = (stdout: string): GuestProbe | undefined => {
    const [buddyinfo = "", orderText = "", cmdline = "", pageText = ""] = stdout.split(/^--\r?$/m);
    const blocks = freeBlocksByOrder(buddyinfo);
    const order = orderText.trim() === "" ? Number.NaN : Number(orderText.trim());
    if (blocks.length === 0 || !Number.isInteger(order) || order < 0) {
        return undefined;
    }
    const page = Number(pageText.trim());
    const probe: GuestProbe = { blocks, order, pageBytes: Number.isInteger(page) && page > 0 ? page : DEFAULT_PAGE_BYTES };
    const bootOrder = cmdlineOrder(cmdline);
    if (bootOrder !== undefined) {
        probe.bootOrder = bootOrder;
    }
    return probe;
};

export interface FreeSplit {
    readonly reportableBytes: number;
    readonly strandedBytes: number;
}

/** The guest's free memory split at `order`: what free page reporting hands back and what it cannot. Pure. */
export const freeSplit = (probe: Pick<GuestProbe, "blocks" | "pageBytes">, order: number): FreeSplit => {
    let reportableBytes = 0;
    let strandedBytes = 0;
    probe.blocks.forEach((count, blockOrder) => {
        const bytes = count * 2 ** blockOrder * probe.pageBytes;
        if (blockOrder < order) {
            strandedBytes += bytes;
        } else {
            reportableBytes += bytes;
        }
    });
    return { reportableBytes, strandedBytes };
};

export const strandedOf = (probe: GuestProbe): number => freeSplit(probe, probe.order).strandedBytes;

/** The heartbeat's figure for a probe taken `at`, with the order the agent lowered it from while it holds it. Pure. */
export const guestFreeOf = (probe: GuestProbe, at: number, hold: OrderHold | undefined): GuestFreeMemory => {
    const reading: GuestFreeMemory = { ...freeSplit(probe, probe.order), reportingOrder: probe.order, at };
    if (hold !== undefined) {
        reading.loweredFrom = hold.from;
    }
    return reading;
};

// The agent holding the order lowered: what it lowered it from, and since when Windows has been out of tight. `keep`: a VM
// backed by small pages, held until the agent stops.
export interface OrderHold {
    readonly from: number;
    readonly recoveredSince?: number;
    readonly keep?: true;
}

/** Whether WSL booted this VM with small-page backing: a boot order of SMALL_PAGE_BOOT_ORDER or lower. Pure. */
export const smallPageBacked = (probe: Pick<GuestProbe, "bootOrder">): boolean => probe.bootOrder !== undefined && probe.bootOrder <= SMALL_PAGE_BOOT_ORDER;

/** The hold for an order lowered from `from` on the guest `probe` read. Pure. */
export const holdFor = (from: number, probe: Pick<GuestProbe, "bootOrder">): OrderHold => (smallPageBacked(probe) ? { from, keep: true } : { from });

/**
 * The hold as the guest reads now. An order that no longer reads LOWERED_ORDER was set by someone else, or the VM
 * restarted with its own: not the agent's to restore. An order at LOWERED_ORDER the agent holds no record of, on a
 * kernel booted with a higher one, is an earlier agent's that stopped without restoring it (a crash, a kill): adopted, so
 * it is put back. Pure.
 */
export const adoptHold = (hold: OrderHold | undefined, probe: GuestProbe): OrderHold | undefined => {
    if (probe.order !== LOWERED_ORDER) {
        return undefined;
    }
    if (hold !== undefined) {
        return hold;
    }
    return probe.bootOrder !== undefined && probe.bootOrder > LOWERED_ORDER ? holdFor(probe.bootOrder, probe) : undefined;
};

/**
 * Whether to lower the order now: more than STRANDED_WORTH_BYTES of the guest's free memory sits in blocks too small to
 * report, the order is above LOWERED_ORDER and not held by the agent already, and either Windows is under its low line,
 * a drop is due (`dropDue`: the memory a drop frees would mostly be stranded too, so lowering stands in for it), or the
 * VM is backed by small pages and Windows is under a fifth of its memory. Pure.
 */
export const shouldLowerOrder = (memory: HostMemory, probe: GuestProbe, hold: OrderHold | undefined, dropDue: boolean): boolean =>
    hold === undefined &&
    probe.order > LOWERED_ORDER &&
    strandedOf(probe) > STRANDED_WORTH_BYTES &&
    (dropDue || memory.availableBytes < hostMemoryLowBytes(memory.totalBytes) || (smallPageBacked(probe) && !recoveredFromTight(memory)));

/**
 * The hold after a reading of Windows at `now`, and whether to put the kernel's order back: Windows has had more than a
 * fifth of its memory (recoveredFromTight) since `recoveredSince`, for RESTORE_AFTER_MS. Dipping under a fifth again
 * starts that wait over. A hold to `keep` is never put back here, only when the agent stops. Pure.
 */
export interface RestoreStep {
    readonly hold: OrderHold | undefined;
    readonly restore: boolean;
}

export const restoreStep = (hold: OrderHold | undefined, memory: HostMemory, now: number): RestoreStep => {
    if (hold === undefined || hold.keep === true) {
        return { hold, restore: false };
    }
    if (!recoveredFromTight(memory)) {
        return { hold: { from: hold.from }, restore: false };
    }
    const since = hold.recoveredSince ?? now;
    return { hold: { from: hold.from, recoveredSince: since }, restore: now - since >= RESTORE_AFTER_MS };
};

/**
 * Whether the guest is due a read, the last one being `lastProbeAt`: only while Windows is under a fifth of its memory (a
 * PC with room never spawns wsl.exe for this), every minute while it is in a low spell (`lowSince`) and the order could
 * still be lowered, else every five. Pure.
 */
export const probeDue = (memory: HostMemory, lowSince: number | undefined, hold: OrderHold | undefined, lastProbeAt: number, now: number): boolean =>
    !recoveredFromTight(memory) && now - lastProbeAt >= (lowSince !== undefined && hold === undefined ? LOW_PROBE_EVERY_MS : PROBE_EVERY_MS);

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;

// The figures a line about the order gives, before and after: Windows' available memory and the guest's stranded memory.
export interface OrderFigures {
    readonly windows: HostMemory;
    readonly strandedBytes: number | undefined;
}

const strandedText = (bytes: number | undefined): string => (bytes === undefined ? "an unread amount" : gib(bytes));

/** The one line lowering the order leaves in the agent's log; `kept`: held until the agent stops (OrderHold `keep`). Pure. */
export const loweredLine = (distro: string, from: number, before: OrderFigures, after: OrderFigures, afterMs: number, kept = false): string =>
    `Windows had ${gib(before.windows.availableBytes)} of ${gib(before.windows.totalBytes)} available while the WSL VM had ${strandedText(before.strandedBytes)} free in blocks too small to give back (page_reporting_order ${from}): lowered it to ${LOWERED_ORDER} and compacted through ${distro}${kept ? ", to hold until the agent stops since the VM is backed by small pages" : ""}; ${strandedText(after.strandedBytes)} stranded and ${gib(after.windows.availableBytes)} available ${Math.round(afterMs / 1000)}s later.`;

/** The one line putting the order back leaves: `why` is the agent stopping, or Windows having recovered. Pure. */
export const restoredLine = (distro: string, to: number, why: "stopping" | "recovered", before: OrderFigures, after?: OrderFigures, afterMs = 0): string => {
    const reason =
        why === "stopping"
            ? "the agent is stopping"
            : `Windows has had more than a fifth of its memory for ${Math.round(RESTORE_AFTER_MS / 60_000)} min (${gib(before.windows.availableBytes)} of ${gib(before.windows.totalBytes)} available)`;
    const then = after === undefined ? "" : `; ${strandedText(after.strandedBytes)} stranded and ${gib(after.windows.availableBytes)} available ${Math.round(afterMs / 1000)}s later`;
    return `${reason}: put the WSL VM's page_reporting_order back from ${LOWERED_ORDER} to ${to} through ${distro} (${strandedText(before.strandedBytes)} stranded before)${then}.`;
};
