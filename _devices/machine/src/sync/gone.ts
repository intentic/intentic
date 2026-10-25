import { EDGE_VERDICT_HEADER, edgeVerdictIsFinal, edgeVerdictOf } from "@intentic/sandbox-contract/protocol/edge-verdict";
import type { Pairing } from "./config.js";

// Only positive evidence marks a pairing gone: the edge's final unknown-sandbox verdict, or ic missing a previously local sandbox and its trash.
// Set goneSince, pause sync, remove forwards, close the tunnel and stop reports; retry at most hourly and clear the mark on an answer.
// After GONE_RETIRE_MS retire the pairing while keeping its folder/restore points. Absence or a transient 502 alone never proves deletion.

// The trash window: what ic keeps a removed sandbox's volumes for before purging them, and so how long a sandbox said to
// be gone may still come back. A pairing is retired only once that has passed.
export const GONE_RETIRE_MS = 7 * 24 * 60 * 60_000;

// How often a gone sandbox is asked again whether it is still gone: one request an hour, where a live pairing polls every
// five seconds and a failing one every five minutes.
export const GONE_RECHECK_MS = 60 * 60_000;

// What a non-OK answer from the sandbox's address says about it: the edge's final verdict, or nothing. A 502 from
// anything else on the path (a proxy, a CDN) carries no verdict and is read as the outage it may be.
export const answeredGone = (response: Pick<Response, "ok" | "headers">): boolean => {
    if (response.ok) {
        return false;
    }
    const verdict = edgeVerdictOf(response.headers.get(EDGE_VERDICT_HEADER));
    return verdict !== undefined && edgeVerdictIsFinal(verdict);
};

// Thrown by the ports poll for that verdict, so the watcher can tell it from a blip (mirror.ts absorbPairingFailure).
export class SandboxGoneError extends Error {}

// What a pass does about a pairing already marked gone:
// - "wait": nothing at all, not even a poll, until the hour since it was last asked has passed;
// - "recheck": ask it again (its ports poll), which clears the mark if it answers;
// - "retire": the trash window has passed since it was first said to be gone, and it was asked again within the last
//   hour, so the verdict is current: an agent that was itself off for a week asks once before it retires anything.
export type GoneStep = "wait" | "recheck" | "retire";

export const goneStep = (pairing: Pick<Pairing, "goneSince" | "goneCheckedAt">, now: number): GoneStep | undefined => {
    if (pairing.goneSince === undefined) {
        return undefined;
    }
    const asked = pairing.goneCheckedAt ?? pairing.goneSince;
    const current = now - asked < GONE_RECHECK_MS;
    if (now - pairing.goneSince >= GONE_RETIRE_MS) {
        return current ? "retire" : "recheck";
    }
    return current ? "wait" : "recheck";
};

// When a pairing marked gone at `since` is retired, for the line that says so.
export const retiresAt = (since: number): number => since + GONE_RETIRE_MS;

// WHAT THIS MACHINE'S ic SAYS of a sandbox, by the slugs it may know it under (config.ts `pairingSlugs`, plus the one
// it was listed under before):
// - "here": ic lists it, whatever state it is in;
// - "trashed": ic's trash holds it, so it may be restored and is not gone yet (ic purges it after its own week, and then
//   it is);
// - "gone": ic answered its listing and its trash, and neither holds it;
// - "unknown": either did not answer, which is never read as absence.
export type LocalVerdict = "here" | "trashed" | "gone" | "unknown";

export const localVerdict = (
    slugs: readonly string[],
    listed: readonly string[] | undefined,
    trashed: readonly string[] | undefined,
): LocalVerdict => {
    if (listed === undefined) {
        return "unknown";
    }
    if (slugs.some((slug) => listed.includes(slug))) {
        return "here";
    }
    if (trashed === undefined) {
        return "unknown";
    }
    return slugs.some((slug) => trashed.includes(slug)) ? "trashed" : "gone";
};

// Whether this machine's ic is a witness for a pairing's sandbox at all: only for a sandbox kept here. A pairing of a
// hosted sandbox, or of one on another computer, is absent from every listing this machine can make, and that absence
// says nothing.
export const keptHere = (pairing: Pick<Pairing, "transport" | "container" | "icSlug">): boolean =>
    (pairing.transport === "docker" && pairing.container !== undefined) || pairing.icSlug !== undefined;

// The sandboxes `ic sandbox list` (its text form) names under "removed, still recoverable": each line there is
// `removed   <slug> (<n> day(s) left)`. The JSON listing carries no trash, and this is the one place ic says it. The
// caller asks this only of a listing ic answered (exit 0); one it did not answer is no trash reading at all.
export const trashedSlugs = (listing: string): string[] =>
    listing.split(/\r?\n/).flatMap((line) => {
        const match = /^removed\s+(\S+)\s+\(/.exec(line.trim());
        return match?.[1] === undefined ? [] : [match[1]];
    });

// WHAT A DOCKER PAIRING DOES WHEN ITS CONTAINER IS NO LONGER WHAT IT REACHES (2026-10-05). The transport was decided at
// setup and never asked again, so a container removed, or a sandbox moved to another computer, left a session dialling
// a name that answered nothing, forever. Asked again on every prepare and every minute:
// - the container serves this sandbox: "keep";
// - it is stopped, or the engine cannot be asked: "keep", since that is a sandbox not started yet (Docker Desktop after
//   a reboot), which the keeper starts, and the session resumes by itself;
// - it no longer exists: ic is asked (`localVerdict`). Listed: "keep", a swap moving it under its name. Trashed:
//   "pause", with that reason. Gone, or ic not answering: the sandbox still answering at its address with an enrollment
//   this machine holds means it lives elsewhere now, so "ssh"; answering without one, "pause"; silent and gone in ic,
//   "gone", the verdict's own path; silent while ic does not answer, "pause". (2026-10-06) ic's "gone" used to be
//   "gone" even while the sandbox answered: its answer lifted the mark at the hourly recheck and ic set it again a
//   minute later, for as long as the moved sandbox lived.
export type ContainerState = "serves" | "stopped" | "missing" | "unknown";
export type DockerStep = "keep" | "ssh" | "pause-missing" | "pause-trashed" | "gone";

export const dockerStep = (args: {
    readonly container: ContainerState;
    readonly local: LocalVerdict;
    readonly enrolled: boolean;
    readonly answering: boolean;
}): DockerStep => {
    if (args.container !== "missing") {
        return "keep";
    }
    switch (args.local) {
        case "here":
            return "keep";
        case "trashed":
            return "pause-trashed";
        case "gone":
            if (!args.answering) {
                return "gone";
            }
            return args.enrolled ? "ssh" : "pause-missing";
        case "unknown":
            return args.enrolled && args.answering ? "ssh" : "pause-missing";
    }
};
