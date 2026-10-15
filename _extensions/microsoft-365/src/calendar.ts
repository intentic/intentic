import type { CommandContext, Commands } from "./commands.js";
import { type GraphHeaders, type Json, query, segment } from "./graph.js";

// The Outlook calendar. Every change (create, update, cancel) can land in other people's inboxes as an invitation or
// a cancellation, so all of them are `microsoft365.calendar.write` and wait for the owner unless a rule says otherwise.

const EVENT_FIELDS =
    "id,subject,start,end,location,organizer,attendees,isAllDay,isCancelled,isOnlineMeeting,onlineMeeting,showAs,bodyPreview,webLink";
const PAGE_MAX = 100;

interface Attendee {
    readonly emailAddress?: { readonly address?: string };
}

interface Event {
    readonly subject?: string;
    readonly start?: { readonly dateTime?: string; readonly timeZone?: string };
    readonly end?: { readonly dateTime?: string; readonly timeZone?: string };
    readonly location?: { readonly displayName?: string };
    readonly attendees?: readonly Attendee[];
    readonly isOnlineMeeting?: boolean;
    readonly body?: { readonly content?: string };
    readonly comment?: string;
}

// Graph answers times in UTC unless told a zone; `--tz Europe/Warsaw` makes it answer in the office's own.
const zoneHeaders = (ctx: CommandContext): GraphHeaders => {
    const zone = ctx.flag("tz");
    if (zone === undefined) {
        return {};
    }
    try {
        // allow(format-tiers): only checks that Intl knows the zone; nothing it formats reaches a reader
        new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    } catch {
        throw new Error(`--tz takes an IANA time zone such as Europe/Warsaw, not "${zone}"`);
    }
    return { Prefer: `outlook.timezone="${zone}"` };
};

const when = (event: Event): string =>
    `${event.start?.dateTime ?? "?"} – ${event.end?.dateTime ?? "?"}${event.start?.timeZone === undefined ? "" : ` (${event.start.timeZone})`}`;

const attendees = (event: Event): string =>
    (event.attendees ?? [])
        .map((attendee) => attendee.emailAddress?.address ?? "")
        .filter((address) => address !== "")
        .join(", ") || "nobody else";

// The agent's request file, which must at least be one JSON object.
const eventFile = async (ctx: CommandContext): Promise<Event & Json> => {
    const value = await ctx.json();
    if (value === null || Array.isArray(value) || Object(value) !== value) {
        throw new Error("--file must hold one JSON object (a Graph event)");
    }
    // SAFETY: an object, checked above; every field read from it is optional and Graph validates the rest.
    return value as Event & Json;
};

const existing = (ctx: CommandContext): Promise<Event> =>
    ctx.graph.call<Event>(`/me/events/${segment(ctx.id())}?$select=subject,start,end,attendees`);

export const calendarCommands: Commands = {
    calendars: async (ctx) => ctx.graph.list<Json>("/me/calendars?$select=id,name,owner,canEdit,isDefaultCalendar", 200),
    events: async (ctx) => {
        const limit = ctx.limit(100);
        const calendar = ctx.flag("calendar");
        const path = calendar === undefined ? "/me/calendarView" : `/me/calendars/${segment(calendar)}/calendarView`;
        const params = {
            startDateTime: ctx.required("from"),
            endDateTime: ctx.required("to"),
            $select: EVENT_FIELDS,
            $orderby: "start/dateTime",
            $top: String(Math.min(limit, PAGE_MAX)),
        };
        return ctx.graph.list<Json>(`${path}?${query(params)}`, limit, zoneHeaders(ctx));
    },
    read: async (ctx) => ctx.graph.call<Json>(`/me/events/${segment(ctx.id())}`, { headers: zoneHeaders(ctx) }),
    create: async (ctx) => {
        const event = await eventFile(ctx);
        return ctx.act({
            key: "microsoft365.calendar.write",
            path: "/me/events",
            method: "POST",
            body: event,
            summary: `Create "${event.subject ?? "(no title)"}", ${when(event)}`,
            details: [
                `New event "${event.subject ?? "(no title)"}"`,
                `When: ${when(event)}`,
                `Where: ${event.location?.displayName ?? (event.isOnlineMeeting === true ? "online meeting" : "not set")}`,
                `Invites: ${attendees(event)}`,
                "",
                event.body?.content ?? "",
            ].join("\n"),
        });
    },
    update: async (ctx) => {
        const before = await existing(ctx);
        const changes = await eventFile(ctx);
        return ctx.act({
            key: "microsoft365.calendar.write",
            path: `/me/events/${segment(ctx.id())}`,
            method: "PATCH",
            body: changes,
            summary: `Change "${before.subject ?? "(no title)"}", ${when(before)}`,
            details: [
                `Change "${before.subject ?? "(no title)"}" (${when(before)})`,
                `Attendees who may be notified: ${attendees(before)}`,
                "",
                "Changes:",
                JSON.stringify(changes, null, 2),
            ].join("\n"),
        });
    },
    cancel: async (ctx) => {
        const before = await existing(ctx);
        const request = await eventFile(ctx);
        return ctx.act({
            key: "microsoft365.calendar.write",
            path: `/me/events/${segment(ctx.id())}/cancel`,
            method: "POST",
            body: request,
            summary: `Cancel "${before.subject ?? "(no title)"}", ${when(before)}`,
            details: [
                `Cancel "${before.subject ?? "(no title)"}" (${when(before)})`,
                `A cancellation goes to: ${attendees(before)}`,
                "",
                request.comment ?? "(no message)",
            ].join("\n"),
        });
    },
};
