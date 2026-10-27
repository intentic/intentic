import type { RawRoutes } from "@intentic/contract-serve";
import { json } from "@intentic/contract-serve";
import { automationsList } from "../../fixture/automations";
import { demoQuiet } from "../../mode";

// The web-chat widget's routes the owner's editor reads (its installs).
// Spread into daemon/raw.ts's table; a route answered here is taken out of unserved.ts.

const HOUR = 3_600_000;

// Which sites have loaded a Visitor chat's widget, newest first, as the daemon records each load: the marketing site on
// its allowlist, and in the loud recording a staging copy the allowlist refuses, which is the row that tells the owner
// what to add. A Visitor chat nobody has loaded reports no origins at all.
const installsOf = (id: string) => {
    const automation = automationsList(Date.now()).find((candidate) => candidate.id === id);
    if (automation?.trigger.kind !== `listener` || automation.trigger.provider !== `webchat`) {
        return [];
    }
    const now = Date.now();
    const allowed = (automation.trigger.allowedOrigins ?? []).map((origin, index) => ({ origin, allowed: true, lastSeenAt: now - (index + 1) * 0.4 * HOUR, loads: 412 - index * 97 }));
    return demoQuiet() ? allowed : [{ origin: `https://staging.acme.example`, allowed: false, lastSeenAt: now - 0.2 * HOUR, loads: 3 }, ...allowed];
};

export const webchatRoutes = {
    "GET /webchat/{id}/installs": ({ param }) => json({ origins: installsOf(param(`id`)) }),
} satisfies RawRoutes;
