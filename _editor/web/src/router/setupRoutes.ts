import { isHostedTierId } from "@intentic/constants";
import type { LocationQuery, RouteLocationGeneric, RouteRecordRaw } from "vue-router";
import { z } from "zod";

// THE SETUP PAGE'S OLD ADDRESSES, kept as ways into Home (2026-10-26). A new sandbox is made on Home, in a dialog and then a
// tile of its own (features/home/newSandbox/), and a setup left unfinished is finished there too; /setup, a page of its
// own that took the reader off Home, and /start/hosted, the pricing page's way in, are gone. What still names them (a
// bookmark, the platform's emailed link before it changed, an older desktop app, the site's pricing page, a checkout's
// way back) lands on Home's address for the same ask:
//   /setup                              → /home?add=sandbox
//   /setup?sandbox=<id>                 → /home?add=sandbox&finish=<id> (and `machine=hosted`: on a machine of ours)
//   /setup?machine=hosted (elsewhere=1) → /home?add=sandbox&machine=hosted
//   /start/hosted?tier=<id>             → /home?add=sandbox&machine=hosted&tier=<id>
// `found=` (what the desktop app found signed in on this computer) rides along every time.

const Single = z.string().min(1);
const single = (value: LocationQuery[string] | undefined): string | undefined => {
    const read = Single.safeParse(value);
    return read.success ? read.data : undefined;
};

/** What Home's address asks of the new sandbox (features/home/newSandbox/newSandbox.ts reads it back). */
// A type rather than an interface: a route's query takes it only with the index signature a type literal carries.
type HomeAsk = {
    add: `sandbox`;
    finish?: string;
    machine?: `hosted`;
    tier?: string;
    found?: string;
};

/** Home's address asking for a new sandbox, as an old setup address asked for it. */
export type HomeForSetup = {
    readonly path: `/home`;
    readonly query: HomeAsk;
};

/** Home's address for what an old setup address asked. */
export const homeForSetup = (path: string, query: LocationQuery): HomeForSetup => {
    const hosted = path === `/start/hosted` || single(query[`machine`]) === `hosted`;
    const tier = single(query[`tier`]);
    const finish = path === `/setup` ? single(query[`sandbox`]) : undefined;
    const found = single(query[`found`]);
    const asked: HomeAsk = { add: `sandbox` };
    if (finish !== undefined) {
        asked.finish = finish;
    }
    if (hosted) {
        asked.machine = `hosted`;
        if (isHostedTierId(tier)) {
            asked.tier = tier;
        }
    }
    if (found !== undefined) {
        asked.found = found;
    }
    return { path: `/home`, query: asked };
};

const toHome = (to: RouteLocationGeneric) => homeForSetup(to.path, to.query);

// Named still, so a link that names the old page (`{ name: "setup" }`) lands where its address would.
export const setupRoutes: RouteRecordRaw[] = [
    { path: `/start/hosted`, name: `hosted-start`, redirect: toHome },
    { path: `/setup`, name: `setup`, redirect: toHome },
];
