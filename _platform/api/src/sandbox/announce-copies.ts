import { AnnounceBodySchema, type DuplicateCopies } from "@intentic/api-contract";
import { z } from "zod";
import { HOUR_MS } from "../durations.js";

/* WHICH COPIES OF A SANDBOX ARE ANNOUNCING (2026-10-05). The connect token is the sandbox's identity, and any container
 * holding it is accepted: pasting the setup command into PowerShell and into WSL on one PC, or restoring a backup on a
 * second machine, makes two containers that both announce, the last write winning on the row, while the edge hands the
 * tunnel back and forth between them every minute. A daemon new enough names which copy it is (`instance`, minted once
 * per container start, with the machine's name and side, AnnounceBodySchema), and the row keeps the last two distinct
 * copies that announced (`seenInstances`), each with when it first and last did.
 *
 * Two copies are side by side when both have announced within the last hour and the stretches over which each is known
 * to run overlap by SIDE_BY_SIDE_MS or more: from the later one's first announce to the earlier one's latest. A restart
 * mints a new instance whose first announce comes after the old one's last, so its stretches never overlap; a cutover
 * whose old container announces once more as it stops overlaps by a minute; two copies that keep running overlap more
 * with every heartbeat, and are named within about an hour of the second one starting. The brief this answers asked for
 * "two instances within ten minutes of each other, and both again within the hour": with an hourly heartbeat at a
 * jittered minute, two live copies can announce up to an hour apart forever, so the overlap of their stretches is what
 * is read rather than the gap between two announces, and it covers that case too.
 *
 * `duplicateSince` is set by the announce that proves the overlap and kept while it lasts; it clears on the first
 * announce after the other copy has been silent an hour. The owner's summary names both copies (`duplicateCopies`)
 * while either still announces; the registry's half of "one instance per sandbox", whose other half is netd
 * standing down after it is displaced again and again. A read-modify-write without a lock: two announces racing can
 * lose one entry, which the next heartbeat writes back. */

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
}

// One optional field of the body, trimmed and held to the contract's own bounds; dropped, never fatal, when it is not
// one: an announce is never refused for a label.
const fieldOf = (schema: z.ZodType<string | undefined>, value: unknown): string | undefined => {
    const parsed = schema.safeParse(typeof value === `string` ? value.trim() : value);
    return parsed.success && parsed.data !== `` ? parsed.data : undefined;
};

// Which copy sent this announce, or undefined from a daemon too old to name its instance.
export const announcedCopyOf = (
    body: { readonly instance?: unknown; readonly host?: unknown; readonly os?: unknown } | undefined,
): AnnouncedCopy | undefined => {
    const instance = fieldOf(AnnounceBodySchema.shape.instance, body?.instance);
    if (instance === undefined) {
        return undefined;
    }
    const host = fieldOf(AnnounceBodySchema.shape.host, body?.host);
    const os = fieldOf(AnnounceBodySchema.shape.os, body?.os);
    return { instance, ...(host === undefined ? {} : { host }), ...(os === undefined ? {} : { os }) };
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
    const self: SeenCopy = {
        instance: copy.instance,
        ...(host === undefined ? {} : { host }),
        ...(os === undefined ? {} : { os }),
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
