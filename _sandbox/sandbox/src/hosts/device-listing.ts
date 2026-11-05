import { errorMessage } from "@intentic/base/errors";
import { type DeviceGap, type DeviceReport, type DeviceSandbox, DeviceSandboxSchema } from "@intentic/sandbox-contract/schemas/devices";
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

// One pull as it came back: the reading, and which of its halves were late.
export interface Reading {
    readonly result: PullResult;
    readonly late: LateHalves;
}

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
    error instanceof DOMException && error.name === "TimeoutError" ? `no answer within ${deadlineMs / 1000} s` : errorMessage(error);

export const gapOf = (result: PullResult): DeviceGap | undefined => ("gap" in result ? result.gap : undefined);

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
