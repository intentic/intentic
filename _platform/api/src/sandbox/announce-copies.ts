import { AnnounceBodySchema, type DuplicateCopies } from "@intentic/api-contract";
import { z } from "zod";
import { HOUR_MS } from "../durations.js";

/* Track the last two announced container instances; a connect token can be copied, causing competing tunnels.
 * Duplicates require both copies heard within an hour and overlapping lifetimes of at least SIDE_BY_SIDE_MS, excluding restarts/cutovers.
 * Keep duplicateSince until a copy is silent an hour; expose duplicateCopies while either still announces.
 * Updates are unlocked: racing announces may lose an entry temporarily, repaired by the next heartbeat. */

// How long two copies' known running stretches must overlap before they are called two copies rather than a cutover.
export const SIDE_BY_SIDE_MS = 10 * 60_000;
// The other copy silent this long: the announcing one is alone, and the flag clears.
export const ALONE_MS = HOUR_MS;
// Both copies silent this long: nothing is running to warn about, whatever the flag says (the hourly heartbeat, with
// its jitter, and room for one missed beat).
const QUIET_MS = 2 * HOUR_MS + 15 * 60_000;

const SeenCopySchema = z.object({
    instance: z.string(),
    host: z.string().optional(),
    os: z.string().optional(),
    engine: z.string().optional(),
    firstAt: z.string(),
    at: z.string(),
});
export type SeenCopy = z.infer<typeof SeenCopySchema>;

// The column as stored, or nothing for a row with none or one that no longer parses.
export const seenCopiesOf = (stored: unknown): SeenCopy[] => {
    const parsed = z.array(SeenCopySchema).max(2).safeParse(stored);
    return parsed.success ? parsed.data : [];
};

export interface AnnouncedCopy {
    readonly instance: string;
    readonly host?: string;
    readonly os?: string;
    readonly engine?: string;
}

// One optional field of the body, trimmed and held to the contract's own bounds; dropped, never fatal, when it is not
// one: an announce is never refused for a label.
const fieldOf = (schema: z.ZodType<string | undefined>, value: unknown): string | undefined => {
    const parsed = schema.safeParse(typeof value === `string` ? value.trim() : value);
    return parsed.success && parsed.data !== `` ? parsed.data : undefined;
};

// Which copy sent this announce, or undefined from a daemon too old to name its instance.
export const announcedCopyOf = (
    body: { readonly instance?: unknown; readonly host?: unknown; readonly os?: unknown; readonly engine?: unknown } | undefined,
): AnnouncedCopy | undefined => {
    const instance = fieldOf(AnnounceBodySchema.shape.instance, body?.instance);
    if (instance === undefined) {
        return undefined;
    }
    const host = fieldOf(AnnounceBodySchema.shape.host, body?.host);
    const os = fieldOf(AnnounceBodySchema.shape.os, body?.os);
    const engine = fieldOf(AnnounceBodySchema.shape.engine, body?.engine);
    return {
        instance,
        ...(host === undefined ? {} : { host }),
        ...(os === undefined ? {} : { os }),
        ...(engine === undefined ? {} : { engine }),
    };
};

export interface CopiesState {
    readonly seen: readonly SeenCopy[];
    readonly duplicateSince: Date | null;
}

// How long two copies are both known to have been running: from the later first announce to the earlier latest one.
const overlapMs = (left: SeenCopy, right: SeenCopy): number =>
    Math.min(Date.parse(left.at), Date.parse(right.at)) - Math.max(Date.parse(left.firstAt), Date.parse(right.firstAt));

// The row's copies after this announce: this copy first, beside the most recent other one, and the flag as it now stands.
export const noteAnnounce = (held: CopiesState, copy: AnnouncedCopy, now: Date): CopiesState => {
    const at = now.toISOString();
    const known = held.seen.find((entry) => entry.instance === copy.instance);
    const host = copy.host ?? known?.host;
    const os = copy.os ?? known?.os;
    // The engine as it is now, not as it was: a move between engines keeps the instance only until the next start.
    const engine = copy.engine ?? known?.engine;
    const self: SeenCopy = {
        instance: copy.instance,
        ...(host === undefined ? {} : { host }),
        ...(os === undefined ? {} : { os }),
        ...(engine === undefined ? {} : { engine }),
        firstAt: known?.firstAt ?? at,
        at,
    };
    const [other] = held.seen
        .filter((entry) => entry.instance !== copy.instance)
        .toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at));
    if (other === undefined || now.getTime() - Date.parse(other.at) > ALONE_MS) {
        return { seen: other === undefined ? [self] : [self, other], duplicateSince: null };
    }
    const sideBySide = overlapMs(self, other) >= SIDE_BY_SIDE_MS;
    return { seen: [self, other], duplicateSince: sideBySide ? (held.duplicateSince ?? now) : held.duplicateSince };
};

// How the summary names a copy: the machine's own name and its side, as far as the copy said.
const copyWords = (copy: SeenCopy): string => {
    const host = copy.host ?? `an unnamed machine`;
    return copy.os === undefined ? host : `${host} (${copy.os})`;
};

// The owner's summary: both copies and since when, while either still announces; null otherwise.
export const duplicateCopiesOf = (stored: unknown, duplicateSince: Date | null, now: Date): DuplicateCopies | null => {
    const seen = seenCopiesOf(stored);
    if (duplicateSince === null || seen.length < 2 || now.getTime() - Math.max(...seen.map((copy) => Date.parse(copy.at))) > QUIET_MS) {
        return null;
    }
    return { hosts: seen.map(copyWords), since: duplicateSince.toISOString() };
};
