import { within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { type DeviceGap, type DeviceReport, type DeviceSandbox, DeviceSandboxSchema, REPORT_QUIET_AFTER_MS } from "@intentic/sandbox-contract/schemas/devices";
import { z } from "zod";
import type { Services } from "../composition.js";
import { createRepeatGate } from "../logs/repeat-gate.js";
import type { PullResult } from "./device-reports.js";

// What a machine's own list_sandboxes tool answered, read the one way the device pull (device-reports.ts) reads it:
// the containers it listed, or why it listed none.

const DeviceSandboxRowsSchema = z.array(DeviceSandboxSchema);

// An answer this build cannot parse is no reading; JSON.parse throws nothing else for a string, and anything else is a bug.
const rowsOf = (text: string): DeviceSandbox[] | undefined => {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
    const rows = DeviceSandboxRowsSchema.safeParse(parsed);
    return rows.success ? rows.data : undefined;
};

// Containers come only through an approved host capability, never the sync agent. Reads the machine's own
// list_sandboxes tool; a refusal, a too-old agent or an answer this build cannot read is no reading, never "none there".
export const sandboxesFromTool = (text: string, refused: boolean): DeviceSandbox[] | undefined =>
    refused ? undefined : rowsOf(text.trim());

// Long enough for the machine's sentence and the reason it quotes; a usage dump after it is not for a card.
const UNREAD_MAX_CHARS = 300;

// Why a machine that answered did not list: the first line of its refusal or failure ("ic could not list this device's
// sandboxes: …", a switch that is off). Undefined for a listing, and for silence, which says nothing about why.
export const unreadFromTool = (text: string, refused: boolean): string | undefined => {
    const line = refused ? text.split(/\r?\n/).find((part) => part.trim() !== "")?.trim() : undefined;
    return line === undefined ? undefined : line.slice(0, UNREAD_MAX_CHARS);
};

// LATENESS. A machine reading that came back LATE, as opposed to one that came back with an answer. The device pull asks a
// machine two things under one deadline (device-reports.ts): its description of itself and the containers it holds. A
// half that gets no answer at all, because the deadline ran out or the transport dropped mid-call, says nothing about
// the machine: it is still connected (the hub reads a dropped connection as offline without ever asking), only slow.
//
// A loaded host lists its containers in 4-8 s and the 8 s deadline sat at its p95 (devices.pull, 2026-11-05, load
// average past 100). A single late reading used to replace the machine's last answer with "offline, no containers"
// for a whole TTL, and that put every button gated on the listing ("Rebuild from checkout", a row's swap and stop)
// back to its copyable command until the next reading landed: 68 times in two days on the owner's workstation.
// Lateness is not an answer, so the last real one stands, for as long as a container list plausibly stays true.

// How long a late half keeps reading as the machine's last real answer. Past it the gap shows as it always did.
export const LATE_KEEP_MS = 10 * 60_000;

interface Answered<T> {
    readonly value: T | undefined;
    readonly at: number;
}

// Each half's last real answer and when it came; a refusal the machine sent is an answer too, and is remembered as one.
export interface AnswerMemory {
    report?: Answered<DeviceReport>;
    sandboxes?: Answered<readonly DeviceSandbox[]>;
}

// Why each half that got no answer got none; a half that answered (a refusal included) is absent.
export interface LateHalves {
    report?: string;
    sandboxes?: string;
}

// What one half of a pull says once it answers: the machine's description of itself (or the gap standing in for it),
// or its containers (or its sentence for not listing them).
export type DescribedHalf = { readonly report: DeviceReport } | { readonly gap: DeviceGap };
export type ListedHalf = Pick<PullResult, "sandboxes" | "sandboxesUnread">;

// The halves that missed the reading's deadline and are still on the wire. Lateness is a deadline on the READER, not on
// the machine: a host that takes 9.5 s to list (rog's distro at load average 30, 2026-11-07) against an 8 s deadline
// had every call cut off, so it never got a single listing in. Its last answer lapsed after LATE_KEEP_MS, and "Rebuild
// from checkout" went back to its copyable command for as long as the load lasted. Now its answer lands when it comes.
export interface LateLandings {
    report?: Promise<DescribedHalf> | undefined;
    sandboxes?: Promise<ListedHalf> | undefined;
}

// One pull as it came back: the reading, which of its halves were late, and those halves still on their way.
export interface Reading {
    readonly result: PullResult;
    readonly late: LateHalves;
    readonly landing?: LateLandings;
}

// Which containers the machine holds and whether each runs, as one comparable string; undefined when it did not list.
const containersOf = (result: PullResult): string | undefined =>
    result.sandboxes
        ?.map((box) => `${box.slug}:${box.running ? "up" : "down"}`)
        .toSorted()
        .join(",");

// A landing worth waking watchers for: the machine's first reading, a change in whether it answers at all or in the
// containers it holds, or a fresh reading replacing one already old enough to read as quiet. Containers count because
// a reader that does not poll (the switcher's remove dialog, a row's placement) decides "is there a button for this" on
// them, and a sandbox created or removed out there would otherwise stay unknown to it until the page reloads. A
// routine refresh of a healthy device announces nothing, so an open Devices tab is not refetched every TTL for news it
// already has.
export const worthAnnouncing = (before: { at: number; result: PullResult | undefined }, after: PullResult, at: number): boolean =>
    before.result === undefined ||
    gapOf(before.result) !== gapOf(after) ||
    containersOf(before.result) !== containersOf(after) ||
    at - before.at > REPORT_QUIET_AFTER_MS;

// Why a half is late when the reading stopped waiting for it.
const deadlineReason = (deadlineMs: number): string => `no answer within ${deadlineMs / 1000} s`;

const MISSED = Symbol("missed");

// One half of a reading, waited for until the reading's deadline: its answer, or `missing` with `late` told why. A half
// still on the wire at the deadline is handed over as well, so its answer can land when it comes (LateLandings); one
// that failed outright has none to give.
export const readHalf = async <T>(
    work: Promise<T>,
    deadlineMs: number,
    missing: T,
    late: (reason: string, pending: Promise<T> | undefined) => void,
): Promise<T> => {
    try {
        const answer = await within(work, deadlineMs, MISSED, { unref: true });
        if (answer !== MISSED) {
            return answer;
        }
        late(deadlineReason(deadlineMs), work);
    } catch (error) {
        late(error instanceof Error ? lateReason(error, deadlineMs) : String(error), undefined);
    }
    return missing;
};

// The machine's list_sandboxes answer as a reading's half. Absent, not empty, when the machine wouldn't answer: "none
// there" is a reading, and this isn't one.
export const listedOf = (fleet: { text: string; refused: boolean }): ListedHalf => {
    const sandboxes = sandboxesFromTool(fleet.text, fleet.refused);
    if (sandboxes !== undefined) {
        return { sandboxes };
    }
    const unread = unreadFromTool(fleet.text, fleet.refused);
    return unread === undefined ? {} : { sandboxesUnread: unread };
};

// Each late half handed to `take` as it answers.
export const whenLanded = (
    landing: LateLandings | undefined,
    take: (half: DescribedHalf | ListedHalf, which: "report" | "sandboxes") => void,
): void => {
    // allow(silent-catch): a half that never answers was already logged late by its reading; the failure adds nothing.
    landing?.report?.then((half) => take(half, "report")).catch(() => undefined);
    // allow(silent-catch): as above, for the listing.
    landing?.sandboxes?.then((half) => take(half, "sandboxes")).catch(() => undefined);
};

// The reading once a late half has answered: that half as the machine said it, which also replaces the memory of that
// half, beside the other half exactly as `served` has it. A landing is a reading of one half and nothing else.
export const landLateHalf = (memory: AnswerMemory, served: PullResult, half: DescribedHalf | ListedHalf, now: number): PullResult => {
    const head: DescribedHalf = "report" in served ? { report: served.report } : { gap: served.gap };
    const listed: ListedHalf =
        served.sandboxes !== undefined ? { sandboxes: served.sandboxes } : served.sandboxesUnread === undefined ? {} : { sandboxesUnread: served.sandboxesUnread };
    const described = "report" in half || "gap" in half;
    const result: PullResult = described ? { ...half, ...listed } : { ...head, ...half };
    // The other half is marked late so its memory stays as it was: this landing says nothing new about it.
    const untouched = "not part of this landing";
    return keepLastAnswer(memory, { result, late: described ? { sandboxes: untouched } : { report: untouched } }, now);
};

const recent = <T>(half: Answered<T> | undefined, now: number): T | undefined =>
    half !== undefined && now - half.at <= LATE_KEEP_MS ? half.value : undefined;

// The reading a reader is served: each answered half as the machine said it, which also replaces the memory of that
// half, and each late half as the machine last said it while that is under LATE_KEEP_MS old.
export const keepLastAnswer = (memory: AnswerMemory, reading: Reading, now: number): PullResult => {
    const { result, late } = reading;
    if (late.report === undefined) {
        memory.report = { value: "report" in result ? result.report : undefined, at: now };
    }
    if (late.sandboxes === undefined) {
        memory.sandboxes = { value: result.sandboxes, at: now };
    }
    const report = late.report === undefined ? undefined : recent(memory.report, now);
    const sandboxes = late.sandboxes === undefined ? undefined : recent(memory.sandboxes, now);
    if (report === undefined && sandboxes === undefined) {
        return result;
    }
    const head = report !== undefined ? { report } : "report" in result ? { report: result.report } : { gap: result.gap };
    const listed = sandboxes ?? result.sandboxes;
    if (listed !== undefined) {
        return { ...head, sandboxes: listed };
    }
    return result.sandboxesUnread === undefined ? head : { ...head, sandboxesUnread: result.sandboxesUnread };
};

// What a half that got no answer is logged with: the deadline in words, else what the transport said.
export const lateReason = (error: Error, deadlineMs: number): string =>
    error instanceof DOMException && error.name === "TimeoutError" ? deadlineReason(deadlineMs) : errorMessage(error);

const gapOf = (result: PullResult): DeviceGap | undefined => ("gap" in result ? result.gap : undefined);

// THE LOG LINE A READING LEAVES. Every failed reading turned into `offline` (or another gap) and said why to nobody: a device shown asleep that was in
// fact refusing, timing out or unreachable could not be told apart afterwards. One line per change of a device's gap
// and its reason, the repeats folded into a count, and one line when it answers again.
const readings = createRepeatGate();

// `missed` is a half's lateness, logged even when its last answer stood in for it: a machine slow enough to miss the
// deadline is worth one line, whether or not a reader could tell.
export const noteReading = (services: Pick<Services, "logger">, id: string, result: PullResult, missed: string | undefined): void => {
    const gap = gapOf(result);
    if (gap === undefined && missed === undefined) {
        const outage = readings.clear(id);
        if (outage !== undefined) {
            services.logger.info({ device: id, was: outage.state, repeated: outage.repeated }, `device reads: ${id} answering again`);
        }
        return;
    }
    const reason = missed ?? (gap === "offline" ? "no connection to it" : gap === "scope-off" ? `its "Run commands" switch is off` : "its agent did not answer the report call");
    const verdict = readings.check(id, `${gap ?? "late"}: ${reason}`);
    if (verdict.log) {
        const said = gap === undefined ? `answered late (${reason}); its last answer stands` : `read as ${gap} (${reason})`;
        services.logger.info({ device: id, gap, reason, repeated: verdict.repeated }, `device reads: ${id} ${said}`);
    }
};
