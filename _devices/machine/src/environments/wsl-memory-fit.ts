import { COST_BYTES, SIZE_BYTES } from "@intentic/constants/memory-room";
import { hostMemoryLowBytes } from "@intentic/sandbox-contract/schemas/hosts";
import type { WslMemoryCap, WslMemoryFit } from "@intentic/sandbox-contract/schemas/wsl-memory";

/* WHEN THE WSL2 VM IS TOO BIG FOR ITS PC, AND WHAT SIZE WOULD FIT (2026-11-26). rog (31.4 GiB) gives its VM
   `memory=22GB`; the VM keeps what it is given, and Windows sat at 2-5 GiB available for hours, under its 3.1 GiB low
   line, while vmmemWSL held 16.6 GiB in RAM. Dropping the VM's file cache gave back a median 0.2 GiB a drop
   (windows-memory.ts): the size itself does not fit. Pure decisions over a history of readings; the resident agent
   takes one every SAMPLE_EVERY_MS (wsl-memory-watch.ts) and reports the result in its facts (`DeviceFacts.wslMemory`).

   Too big: over a window of hours, not minutes (a build's burst is not a size problem), Windows was under its low line
   in most readings while the VM held a large share of the RAM. Then the size that fits is what is left once Windows has
   its own use outside the VM (total - available - the VM's working set, at a high percentile over the window, since
   the VM must fit Windows' busy hours too), its low line, and a margin: the percentile is a sample, and the VM's own
   process holds a little beyond its guest's RAM. Rounded down to a whole GB, since rounding up would spend the margin.
   Never under a floor that still runs one sandbox. Proposed only when it is worth a WSL restart, which restarts every
   sandbox on the PC: at least MIN_CHANGE_GB under what `.wslconfig` gives the VM now. WSL reads `memory=22GB` as 22 GiB,
   so a GB here is a GiB throughout. */

const GIB = 1024 ** 3;

// One reading every five minutes: a `tasklist` (about 150 ms on rog) and one `os.freemem()`.
export const SAMPLE_EVERY_MS = 5 * 60_000;
// What is decided on: the last four hours.
export const FIT_WINDOW_MS = 4 * 3_600_000;
// Hours, not minutes: readings spanning less than three hours, or fewer than two hours' worth of them, decide nothing.
const MIN_SPAN_MS = 3 * 3_600_000;
const MIN_READINGS = 24;
// "Most of the window": Windows under its low line in at least this share of the readings.
const MIN_UNDER_SHARE = 0.6;
// "A large share": the VM's median working set at least a third of the RAM, and more than the size proposed, so capping
// it gives Windows something back. Otherwise Windows' own programs are what fill it, and a smaller VM would not help.
const VM_LARGE_SHARE = 1 / 3;
// Windows' own use at the 90th percentile of the window.
const OUTSIDE_PERCENTILE = 0.9;
// Beside the low line: the percentile's error, and the VM process's own pages beyond its guest's RAM.
const MARGIN_BYTES = 0.5 * GIB;
// One sandbox doing its heaviest work: the largest command the heavy-command queue prices (a cargo build, the editor's
// typecheck: 7 GiB) and the agent runtime running it (memory-room.mjs). The same 7 GiB ic asks of a PC to install on.
export const VM_FLOOR_BYTES = Math.max(...Object.values(SIZE_BYTES)) + COST_BYTES.agentRuntime;
// A smaller change is not worth restarting every sandbox on the PC.
export const MIN_CHANGE_GB = 2;
// WSL's own default for a `.wslconfig` without `memory=`: half the RAM.
const WSL_DEFAULT_SHARE = 0.5;

export interface WslMemoryReading {
    readonly at: number;
    // Windows' available physical memory (os.freemem() on Windows: ullAvailPhys, standby cache included).
    readonly availableBytes: number;
    readonly totalBytes: number;
    // vmmemWSL's working set: the VM's own footprint in RAM. 0 when the VM was not running.
    readonly vmBytes: number;
}

// Windows' own use outside the VM in one reading: whatever is neither available nor the VM's. Pure.
export const outsideVmBytes = (reading: WslMemoryReading): number => Math.max(0, reading.totalBytes - reading.availableBytes - reading.vmBytes);

/** The `share` percentile (0-1) of `values`, nearest-rank; undefined for none. Pure. */
export const percentile = (values: readonly number[], share: number): number | undefined => {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = values.toSorted((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil(share * sorted.length)));
    return sorted[rank - 1];
};

/** The readings a decision at `now` rests on: those of the last FIT_WINDOW_MS, oldest first. Pure. */
const windowOf = (readings: readonly WslMemoryReading[], now: number): WslMemoryReading[] =>
    readings.filter((reading) => reading.at <= now && now - reading.at <= FIT_WINDOW_MS).toSorted((a, b) => a.at - b.at);

/** The whole GB a VM may have on a PC of `totalBytes` whose own use outside it is `outsideBytes`, and whether that is the floor. Pure. */
export const proposedVmGb = (totalBytes: number, outsideBytes: number): { readonly gb: number; readonly atFloor: boolean } => {
    const fits = Math.floor((totalBytes - outsideBytes - hostMemoryLowBytes(totalBytes) - MARGIN_BYTES) / GIB);
    const floor = Math.ceil(VM_FLOOR_BYTES / GIB);
    return fits < floor ? { gb: floor, atFloor: true } : { gb: fits, atFloor: false };
};

const gib = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GiB`;
const hoursWords = (ms: number): string => {
    const hours = Math.round((ms / 3_600_000) * 10) / 10;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
};

// The agent's sentence for what was measured and what is proposed. Pure.
const fitText = (fit: Omit<WslMemoryFit, "text" | "capsOver">): string => {
    const now = fit.configuredGb === undefined ? `.wslconfig sets no memory=, so WSL gives the VM half the RAM` : `.wslconfig gives the VM memory=${fit.configuredGb}GB`;
    const proposal = fit.atFloor
        ? `memory=${fit.proposedGb}GB is the least that still runs one sandbox's heaviest work, though Windows would still be short with its own use as it is`
        : `memory=${fit.proposedGb}GB would leave Windows its own use, its low line and ${gib(MARGIN_BYTES)} to spare`;
    return `Windows had less than its ${gib(fit.lowLineBytes)} low line available in ${Math.round(fit.underLowShare * 100)}% of the readings over the last ${hoursWords(fit.windowMs)} (median ${gib(fit.availableMedianBytes)} of ${gib(fit.totalBytes)}), while the WSL VM held a median ${gib(fit.vmMedianBytes)} in RAM; Windows' own use outside the VM reached ${gib(fit.outsideBytes)} (90th percentile). ${now}; ${proposal}.`;
};

/**
 * Whether the VM is too big for this PC, from the readings of the last FIT_WINDOW_MS before `now` and `memory=` as
 * `.wslconfig` sets it (`configuredGb`, undefined where it sets none), and if so the size that fits. Undefined when the
 * readings are too few or too short to say, when Windows was not short most of the time, when the VM is not what fills
 * it, or when what fits is not at least MIN_CHANGE_GB under what the VM may take now. Pure.
 */
export const wslMemoryFit = (readings: readonly WslMemoryReading[], configuredGb: number | undefined, now: number): Omit<WslMemoryFit, "capsOver"> | undefined => {
    const window = windowOf(readings, now);
    const first = window[0];
    const last = window.at(-1);
    if (first === undefined || last === undefined || window.length < MIN_READINGS || last.at - first.at < MIN_SPAN_MS) {
        return undefined;
    }
    // The newest reading's RAM: it does not change while the agent runs, and a reading is never of another PC.
    const totalBytes = last.totalBytes;
    const lowLineBytes = hostMemoryLowBytes(totalBytes);
    const underLowShare = window.filter((reading) => reading.availableBytes < lowLineBytes).length / window.length;
    const vmMedianBytes = percentile(window.map((reading) => reading.vmBytes), 0.5) ?? 0;
    const outsideBytes = percentile(window.map(outsideVmBytes), OUTSIDE_PERCENTILE) ?? 0;
    const { gb: proposedGb, atFloor } = proposedVmGb(totalBytes, outsideBytes);
    const allowedGb = configuredGb ?? (WSL_DEFAULT_SHARE * totalBytes) / GIB;
    if (underLowShare < MIN_UNDER_SHARE || vmMedianBytes < VM_LARGE_SHARE * totalBytes || vmMedianBytes <= proposedGb * GIB || allowedGb - proposedGb < MIN_CHANGE_GB) {
        return undefined;
    }
    const fit: Omit<WslMemoryFit, "text" | "capsOver"> = {
        at: now,
        windowMs: last.at - first.at,
        readings: window.length,
        totalBytes,
        lowLineBytes,
        underLowShare,
        availableMedianBytes: percentile(window.map((reading) => reading.availableBytes), 0.5) ?? 0,
        vmMedianBytes,
        outsideBytes,
        proposedGb,
        atFloor,
    };
    if (configuredGb !== undefined) {
        fit.configuredGb = configuredGb;
    }
    return { ...fit, text: fitText(fit) };
};

/**
 * The finding with the sandboxes whose container cap is larger than the VM it proposes, said in its text: a cap past
 * the VM's memory is no cap, and the kernel's OOM killer, not the cap, decides what goes. Pure.
 */
export const withCaps = (fit: Omit<WslMemoryFit, "capsOver">, caps: readonly WslMemoryCap[]): WslMemoryFit => {
    const over = caps.filter((cap) => cap.memoryBytes > fit.proposedGb * GIB).toSorted((a, b) => a.name.localeCompare(b.name));
    if (over.length === 0) {
        return fit;
    }
    const named = over.map((cap) => `${cap.name} (${gib(cap.memoryBytes)})`).join(", ");
    return {
        ...fit,
        capsOver: over,
        text: `${fit.text} ${over.length === 1 ? "One sandbox here is" : `${over.length} sandboxes here are`} capped above that: ${named}; a cap past the VM's memory is no cap, so lower ${over.length === 1 ? "it" : "them"} too.`,
    };
};

/** A short why for the line `.wslconfig` gets beside the change: what was measured, in one clause. Pure. */
export const fitReason = (fit: Pick<WslMemoryFit, "lowLineBytes" | "underLowShare" | "windowMs" | "vmMedianBytes" | "totalBytes">): string =>
    `Windows was under its ${gib(fit.lowLineBytes)} low line in ${Math.round(fit.underLowShare * 100)}% of ${hoursWords(fit.windowMs)} of readings while the VM held a median ${gib(fit.vmMedianBytes)} of ${gib(fit.totalBytes)}`;

/** vmmemWSL's working set in bytes from `tasklist /FI "IMAGENAME eq vmmemWSL" /FO CSV /NH`; 0 when it is not listed (the VM is not running). Pure. */
export const vmBytesFromTasklist = (stdout: string): number => {
    const row = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^"vmmemWSL"/i.test(line));
    if (row === undefined) {
        return 0;
    }
    // "vmmemWSL","14616","Services","0","15,166,676 K": the last field, in KiB, grouped the locale's way ("," "." or a space).
    const fields = row.split(`","`);
    const kib = Number((fields.at(-1) ?? "").replace(/\D/g, ""));
    return Number.isFinite(kib) ? kib * 1024 : 0;
};
