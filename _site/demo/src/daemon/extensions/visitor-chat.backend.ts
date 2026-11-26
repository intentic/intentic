import { automationsList } from "../../fixture/automations";
import { demoQuiet } from "../../mode";
import { json } from "../../transport";

// The visitor-chat extension's backend namespace (its src/server/server.ts), which its install panel reads through
// `api.backend` since the Visitor chat left the daemon (2026-11-26; the daemon's GET /webchat/{id}/installs until then):
// which sites have loaded a chat's widget, newest first, as the backend records each load. The marketing site on its
// allowlist, and in the loud recording a staging copy the allowlist refuses, which is the row that tells the owner what
// to add. A Visitor chat nobody has loaded reports no origins at all.
const VISITOR_CHAT = `/x/intentic.visitor-chat`;

const HOUR = 3_600_000;

const installsOf = (allowedOrigins: readonly string[]) => {
    const now = Date.now();
    const allowed = allowedOrigins.map((origin, index) => ({ origin, allowed: true, lastSeenAt: now - (index + 1) * 0.4 * HOUR, loads: 412 - index * 97 }));
    return demoQuiet() ? allowed : [{ origin: `https://staging.acme.example`, allowed: false, lastSeenAt: now - 0.2 * HOUR, loads: 3 }, ...allowed];
};

// One read per Visitor chat in the fixture, by the path the panel asks for.
export const visitorChatBackend: Readonly<Record<string, () => Response>> = Object.fromEntries(
    automationsList(Date.now()).flatMap(({ id, trigger }) => {
        if (trigger.kind !== `listener` || trigger.provider !== `webchat`) {
            return [];
        }
        const origins = trigger.allowedOrigins ?? [];
        return [[`GET ${VISITOR_CHAT}/installs/${encodeURIComponent(id)}`, (): Response => json({ origins: installsOf(origins) })]];
    }),
);
