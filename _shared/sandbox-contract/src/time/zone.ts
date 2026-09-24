// The vocabulary for time values that cross a machine boundary, and the one rule behind all of it: an INSTANT means
// the same thing everywhere, a WALL RULE means nothing without a zone, and a CIVIL DAY is a zone's opinion wearing the
// costume of a fact.
//
// Intentic runs its daemon in a UTC container and its editor in whatever zone the reader's laptop is in. Anything that
// says "at 09:00" was authored on one of those machines and evaluated on the other, so the zone has to travel with it
// or the two disagree by the offset — silently, since both sides render a plausible number.
//
// Instants stay plain `number` (epoch ms) deliberately. That convention is already universal in this codebase and
// already safe; branding it would touch thousands of call sites to prevent a mistake nobody is making. The two types
// below are branded because they are the two that DO get confused for an instant, and each confusion is a shipped bug:
// a civil day rendered in the reader's zone slides a day westward, and a cron evaluated in the wrong zone fires at the
// wrong hour.
import { z } from "zod";

/**
 * A named IANA zone ("Europe/Warsaw"), never a fixed offset. An offset cannot express the summer-time rule that moves
 * "09:00" twice a year, which is exactly what a recurring schedule has to survive.
 */
export type Zone = string & { readonly __brand: "Zone" };

/** The daemon's own zone, and the answer for a sandbox whose owner has never said where they are. */
export const UTC = "UTC" as Zone;

/**
 * Whether ICU knows this id AND it names a place rather than an offset. The platform's own tables are the only honest
 * source for the first half; the second half has to be enforced here, because ICU accepts `+02:00` as a `timeZone`
 * since ES2024 and that is exactly the shape a naive `getTimezoneOffset()` would produce. A fixed offset is frozen at
 * the moment it was read: a schedule stored as `+02:00` in September fires an hour off for the whole of the winter.
 * `Etc/GMT+5` is left alone — it is a real id somebody may genuinely be on, not an accident of arithmetic.
 */
export const isZone = (value: string): value is Zone => {
    if (value.startsWith("+") || value.startsWith("-")) {
        return false;
    }
    try {
        return Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone !== "";
    } catch {
        return false;
    }
};

/** An id from outside (a manifest, a migrated config, a browser) as a `Zone`, or undefined if ICU does not know it. */
export const asZone = (value: string | undefined): Zone | undefined => (value !== undefined && isZone(value) ? value : undefined);

// Rejects at the edge rather than at the croner call: an unknown zone in a manifest should fail the save that
// introduced it, where somebody is still watching, not the tick three hours later.
export const ZoneSchema = z.string().refine(isZone, { message: "Not a zone name ICU knows, e.g. Europe/Warsaw or UTC." });

/**
 * The zone the reader's own machine is in. Browser-side only by nature — in the daemon this answers UTC, which is true
 * but useless, and is why the sandbox keeps a zone setting instead of asking its own clock.
 */
export const localZone = (): Zone => Intl.DateTimeFormat().resolvedOptions().timeZone as Zone;

/**
 * A calendar day as `YYYY-MM-DD`, carrying no time and no zone of its own. Branded so it cannot be handed to a
 * formatter expecting an instant: `new Date("2026-09-20")` parses as UTC midnight, and rendering that in a zone behind
 * UTC prints the 19th. That bug is invisible to whoever writes it, because it is correct in their own zone.
 */
export type CivilDay = string & { readonly __brand: "CivilDay" };

export const CivilDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A calendar day as YYYY-MM-DD.");

/** The calendar day an instant falls on, in a named zone. `en-CA` because its short date format IS ISO order. */
export const civilDayIn = (at: number, zone: Zone): CivilDay =>
    new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at) as CivilDay;

/** The UTC calendar day of an instant. Named rather than spelled inline, so every UTC bucket in the tree is greppable. */
export const utcDayOf = (at: number): CivilDay => new Date(at).toISOString().slice(0, 10) as CivilDay;

/**
 * An instant as a person on a named clock would read it: "2026-09-20 20:43". For text the daemon writes — a log line,
 * a note handed to an agent — where an ISO stamp is unambiguous but unreadable, and where the daemon cannot use the
 * editor's formatters because there is no reader in the room. Never for the interface: on screen an instant is drawn
 * in the reader's own clock, by `_editor/ui/src/lib/format.ts`.
 * `sv-SE` because its short format is ISO-shaped, which is the point: no locale ambiguity in a machine-written line.
 */
export const wallClockIn = (at: number, zone: Zone): string =>
    new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
        .format(at)
        .replace(",", "");

/** A `YYYY-MM-DD` from a store, a query string or a fixture. Undefined for anything that is not one. */
export const asCivilDay = (value: string | undefined): CivilDay | undefined => (value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? (value as CivilDay) : undefined);

/**
 * A recurring wall-clock rule: the cron AND the zone it is meant in, which is the only form in which it means anything.
 * Kept as one type so the two cannot be passed around separately and drift apart — the original bug was a `cron:
 * string` travelling alone from a browser in Europe/Warsaw to a daemon in UTC.
 */
export interface WallRule {
    readonly cron: string;
    readonly tz: Zone;
}

/** What croner has to be given. Never call `new Cron(expr)` bare: that silently means "in whatever zone this process is". */
export const cronOptions = (tz: Zone): { timezone: string } => ({ timezone: tz });

// The offset of a zone at an instant, in minutes east of UTC. Via the formatter's own `longOffset` part, since the
// arithmetic alternative (formatting twice and subtracting) gets the summer-time changeover hour wrong.
const offsetMinutes = (at: number, zone: Zone): number => {
    const part = new Intl.DateTimeFormat("en", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(part ?? "");
    if (match === null) {
        return 0; // "GMT" with no offset is UTC itself.
    }
    return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
};

/** The instant the calendar day after the one `at` falls on begins, in a named zone: where `civilDayIn` next changes. */
export const nextDayStartIn = (at: number, zone: Zone): number => {
    const [year = 0, month = 1, day = 1] = civilDayIn(at, zone).split("-").map(Number);
    const midnightUtc = Date.UTC(year, month - 1, day + 1);
    return midnightUtc - offsetMinutes(midnightUtc, zone) * 60_000;
};

/** Whether two zones are showing the same wall clock right now — which is when naming one on screen would be noise. */
export const sameClock = (a: Zone, b: Zone, at: number = Date.now()): boolean => a === b || offsetMinutes(at, a) === offsetMinutes(at, b);

/**
 * How to name a zone beside a wall-clock time, or undefined when the reader is already on that clock and the label
 * would only add width. The city, not the offset: "Europe/Warsaw" survives the March changeover, "UTC+2" does not.
 */
export const zoneLabel = (rule: Zone, reader: Zone, at: number = Date.now()): string | undefined => (sameClock(rule, reader, at) ? undefined : rule.replace(/_/g, " "));
