import { prettifyError } from "zod";
import { ANALYTICS_EVENTS, type AnalyticsEvent, type EventProperties, type SentProperties } from "./eventRegistry";

// What `track` checks before an event is queued or sent: a name the registry lists and properties its schema accepts,
// and no more than BURST_LIMIT of one name inside BURST_WINDOW_MS. Anything else is dropped whole, never sent with the
// offending property cut: an event that changed shape is a bug at its call site, and half of it would count as data.
// The registry rejects at compile time what it can; this is for what a cast or a wider-than-typed value lets through.

const registered = (event: string): event is keyof typeof ANALYTICS_EVENTS => Object.hasOwn(ANALYTICS_EVENTS, event);

// Said in a development build only: production drops the event quietly, the console being the reader's, not ours.
const DEV = import.meta.env.DEV;

/** The properties to send for `event`, or undefined where the event is unknown or its properties fail its schema. */
export const validEvent = (event: string, properties: EventProperties<AnalyticsEvent> | undefined): SentProperties | undefined => {
    if (!registered(event)) {
        if (DEV) {
            console.warn(`[analytics] dropped "${event}": not in app/analyticsEvents/eventRegistry.ts`);
        }
        return undefined;
    }
    const parsed = ANALYTICS_EVENTS[event].safeParse(properties ?? {});
    if (!parsed.success) {
        if (DEV) {
            console.warn(`[analytics] dropped "${event}": its properties do not match the registry\n${prettifyError(parsed.error)}`);
        }
        return undefined;
    }
    return parsed.data;
};

// A loop that fires an event on every render or every poll would flood the project and its quota; no event the editor
// sends means anything past this rate.
export const BURST_LIMIT = 30;
export const BURST_WINDOW_MS = 60_000;

/** Whether one more `event` may go now: false once BURST_LIMIT of it went within the last BURST_WINDOW_MS. */
export const createBurstCap = (now: () => number = Date.now, limit = BURST_LIMIT, windowMs = BURST_WINDOW_MS) => {
    const sent = new Map<string, number[]>();
    return (event: string): boolean => {
        const at = now();
        const recent = (sent.get(event) ?? []).filter((time) => at - time < windowMs);
        if (recent.length >= limit) {
            sent.set(event, recent);
            if (DEV) {
                console.warn(`[analytics] dropped "${event}": more than ${limit} in ${windowMs / 1000}s`);
            }
            return false;
        }
        recent.push(at);
        sent.set(event, recent);
        return true;
    };
};
