import { type Args, bool, flag, list, positional, required, limit as readLimit } from "../cli/args.js";
import { type Command, type CommandContext, type CommandGroup, printJson } from "../cli/command.js";
import { clip, count, row, tally, when } from "../cli/format.js";
import { call, paginate } from "../google/request.js";
import type { Session } from "../google/session.js";
import { type EventTime, defaultEnd, parseWhen, toInstant } from "../google/time.js";

const API = "https://www.googleapis.com/calendar/v3";

interface CalendarEvent {
    readonly id: string;
    readonly summary?: string;
    readonly description?: string;
    readonly location?: string;
    readonly status?: string;
    readonly htmlLink?: string;
    readonly hangoutLink?: string;
    readonly start?: EventTime;
    readonly end?: EventTime;
    readonly organizer?: { readonly email?: string };
    readonly attendees?: readonly { readonly email?: string; readonly responseStatus?: string; readonly optional?: boolean }[];
}

const calendarId = (args: Args): string => flag(args, "calendar", "cal") ?? "primary";

/* The calendar's own zone, which is what a naive `--start 14:00` means. Fetched rather than assumed, and
 * cached for the process: every time-taking command needs it, and it is one small request per `gw` run. */
const zoneOf = (() => {
    const known = new Map<string, string>();
    return async (session: Session, id: string): Promise<string> => {
        const cached = known.get(id);
        if (cached !== undefined) {
            return cached;
        }
        const calendar = await call<{ timeZone?: string }>(session, { url: `${API}/calendars/${encodeURIComponent(id)}` });
        const zone = calendar.timeZone ?? "UTC";
        known.set(id, zone);
        return zone;
    };
})();

const startsAt = (event: CalendarEvent): string => event.start?.dateTime ?? event.start?.date ?? "";

const eventLine = (event: CalendarEvent): string =>
    row(
        event.id,
        when(startsAt(event)),
        clip(event.summary ?? "(no title)", 56),
        event.location === undefined ? undefined : clip(event.location, 28),
        event.attendees === undefined ? undefined : `${event.attendees.length} invited`,
        event.status === "cancelled" ? "cancelled" : undefined,
    );

// The shape both create and update send. Only the flags that were actually passed appear, so `update` patches
// what was named and leaves the rest of the event alone.
const eventBody = (ctx: CommandContext, zone: string, now: Date): Record<string, unknown> => {
    const { args } = ctx;
    const start = flag(args, "start");
    const end = flag(args, "end");
    const attendees = list(args, "attendees", "with");
    return {
        ...(flag(args, "title") === undefined ? {} : { summary: flag(args, "title") }),
        ...(flag(args, "description") === undefined ? {} : { description: flag(args, "description") }),
        ...(flag(args, "location") === undefined ? {} : { location: flag(args, "location") }),
        ...(start === undefined ? {} : { start: parseWhen(start, now, zone) }),
        ...(end === undefined ? {} : { end: parseWhen(end, now, zone) }),
        ...(attendees.length === 0 ? {} : { attendees: attendees.map((email) => ({ email })) }),
        ...(bool(args, "meet")
            ? {
                  conferenceData: {
                      createRequest: { requestId: `gw-${process.hrtime.bigint().toString(36)}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
                  },
              }
            : {}),
    };
};

const calendars: Command = {
    name: "calendars",
    summary: "List the calendars this account can see",
    usage: "gw cal calendars",
    run: async (ctx) => {
        const items = await paginate<{ id: string; summary?: string; primary?: boolean; accessRole?: string; timeZone?: string }>(
            ctx.session,
            { url: `${API}/users/me/calendarList` },
            { itemsOf: (page) => page["items"] as { id: string }[] | undefined, limit: 250, sizeKey: "maxResults", maxPageSize: 250 },
        );
        if (ctx.json) {
            printJson(ctx, items);
            return;
        }
        for (const item of items) {
            ctx.out(row(item.id, item.summary ?? "", item.timeZone ?? "", item.accessRole ?? "", item.primary === true ? "primary" : undefined));
        }
        ctx.out(count(items.length, "calendars"));
    },
};

const listEvents: Command = {
    name: "list",
    summary: "What is on, between two times",
    usage: 'gw cal list [--calendar id] [--from now] [--to +7d] [--search "text"] [-n 25]',
    run: async (ctx) => {
        const id = calendarId(ctx.args);
        const zone = await zoneOf(ctx.session, id);
        const now = new Date();
        const max = readLimit(ctx.args, 25, 250);
        const events = await paginate<CalendarEvent>(
            ctx.session,
            {
                url: `${API}/calendars/${encodeURIComponent(id)}/events`,
                query: {
                    timeMin: toInstant(flag(ctx.args, "from") ?? "now", now, zone),
                    timeMax: toInstant(flag(ctx.args, "to") ?? "+7d", now, zone),
                    // Recurring events expanded into the occurrences a person would see in their week.
                    singleEvents: true,
                    orderBy: "startTime",
                    q: flag(ctx.args, "search"),
                },
            },
            { itemsOf: (page) => page["items"] as CalendarEvent[] | undefined, limit: max, sizeKey: "maxResults", maxPageSize: 250 },
        );
        if (ctx.json) {
            printJson(ctx, events);
            return;
        }
        for (const event of events) {
            ctx.out(eventLine(event));
        }
        ctx.out(tally(events.length, max, "events"));
    },
};

const show: Command = {
    name: "show",
    summary: "One event in full",
    usage: "gw cal show <eventId> [--calendar id]",
    run: async (ctx) => {
        const event = await call<CalendarEvent>(ctx.session, {
            url: `${API}/calendars/${encodeURIComponent(calendarId(ctx.args))}/events/${encodeURIComponent(positional(ctx.args, 1, "An event id"))}`,
        });
        if (ctx.json) {
            printJson(ctx, event);
            return;
        }
        ctx.out(`Title: ${event.summary ?? "(no title)"}`);
        ctx.out(`Start: ${when(startsAt(event))}`);
        ctx.out(`End: ${when(event.end?.dateTime ?? event.end?.date)}`);
        if (event.location !== undefined) {
            ctx.out(`Location: ${event.location}`);
        }
        if (event.hangoutLink !== undefined) {
            ctx.out(`Meet: ${event.hangoutLink}`);
        }
        ctx.out(`Organizer: ${event.organizer?.email ?? "—"}`);
        for (const attendee of event.attendees ?? []) {
            ctx.out(
                `Attendee: ${attendee.email ?? "?"} (${attendee.responseStatus ?? "needsAction"}${attendee.optional === true ? ", optional" : ""})`,
            );
        }
        if (event.description !== undefined) {
            ctx.out("");
            ctx.out(event.description);
        }
    },
};

const create: Command = {
    name: "create",
    summary: "Put something in the calendar",
    usage: 'gw cal create --title "…" --start "tomorrow 14:00" --end "+1h" [--attendees a@x,b@y] [--location] [--description] [--meet] [--calendar id]',
    writes: true,
    run: async (ctx) => {
        const id = calendarId(ctx.args);
        const zone = await zoneOf(ctx.session, id);
        const now = new Date();
        required(ctx.args, "title");
        required(ctx.args, "start");
        const body = eventBody(ctx, zone, now);
        // An end nobody gave is an hour after the start, which is what a meeting is unless told otherwise.
        const created = await call<CalendarEvent>(ctx.session, {
            method: "POST",
            url: `${API}/calendars/${encodeURIComponent(id)}/events`,
            query: {
                sendUpdates: list(ctx.args, "attendees", "with").length > 0 ? "all" : "none",
                conferenceDataVersion: bool(ctx.args, "meet") ? 1 : 0,
            },
            body: { ...body, end: body["end"] ?? defaultEnd(body["start"] as EventTime) },
        });
        if (ctx.json) {
            printJson(ctx, created);
            return;
        }
        ctx.out(`created ${created.id}  ${when(startsAt(created))}  ${created.summary ?? ""}`);
        if (created.hangoutLink !== undefined) {
            ctx.out(created.hangoutLink);
        }
    },
};

const update: Command = {
    name: "update",
    summary: "Change an event, only the fields you pass",
    usage: "gw cal update <eventId> [--title] [--start] [--end] [--location] [--description] [--attendees] [--calendar id]",
    writes: true,
    run: async (ctx) => {
        const id = calendarId(ctx.args);
        const zone = await zoneOf(ctx.session, id);
        const body = eventBody(ctx, zone, new Date());
        if (Object.keys(body).length === 0) {
            throw new Error("Nothing to change: pass at least one of --title, --start, --end, --location, --description, --attendees.");
        }
        const updated = await call<CalendarEvent>(ctx.session, {
            method: "PATCH",
            url: `${API}/calendars/${encodeURIComponent(id)}/events/${encodeURIComponent(positional(ctx.args, 1, "An event id"))}`,
            query: { sendUpdates: "all" },
            body,
        });
        if (ctx.json) {
            printJson(ctx, updated);
            return;
        }
        ctx.out(`updated ${updated.id}  ${when(startsAt(updated))}  ${updated.summary ?? ""}`);
    },
};

const remove: Command = {
    name: "delete",
    summary: "Cancel an event and tell the guests",
    usage: "gw cal delete <eventId> [--calendar id]",
    writes: true,
    run: async (ctx) => {
        const id = positional(ctx.args, 1, "An event id");
        await call(ctx.session, {
            method: "DELETE",
            url: `${API}/calendars/${encodeURIComponent(calendarId(ctx.args))}/events/${encodeURIComponent(id)}`,
            query: { sendUpdates: "all" },
        });
        ctx.out(`deleted ${id}`);
    },
};

const busy: Command = {
    name: "busy",
    summary: "When some people are free",
    usage: "gw cal busy --emails a@x,b@y --from now --to +3d",
    run: async (ctx) => {
        const zone = await zoneOf(ctx.session, "primary");
        const now = new Date();
        const emails = list(ctx.args, "emails", "who");
        if (emails.length === 0) {
            throw new Error("Pass --emails with at least one address.");
        }
        const answer = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
            ctx.session,
            {
                method: "POST",
                url: `${API}/freeBusy`,
                body: {
                    timeMin: toInstant(flag(ctx.args, "from") ?? "now", now, zone),
                    timeMax: toInstant(flag(ctx.args, "to") ?? "+3d", now, zone),
                    items: emails.map((id) => ({ id })),
                },
            },
        );
        if (ctx.json) {
            printJson(ctx, answer);
            return;
        }
        for (const [email, slot] of Object.entries(answer.calendars ?? {})) {
            const problem = slot.errors?.[0]?.reason;
            if (problem !== undefined) {
                // Almost always "notFound": a calendar outside the organization does not publish free/busy.
                ctx.out(`${email}  unavailable (${problem})`);
                continue;
            }
            for (const period of slot.busy ?? []) {
                ctx.out(row(email, when(period.start), "→", when(period.end)));
            }
            if ((slot.busy ?? []).length === 0) {
                ctx.out(`${email}  free for the whole window`);
            }
        }
    },
};

export const calendarGroup: CommandGroup = {
    name: "cal",
    summary: "Calendar, what is on, book, move, cancel, check who is free",
    commands: [calendars, listEvents, show, create, update, remove, busy],
};
