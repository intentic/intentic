import { z } from "zod";
// A manifest entry id (capabilities + automations + personas), also the `mcp__<id>__…` server name for mcp
// capabilities, so it's a safe identifier.
export const entryId = z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
// A ref name (branch/tag), validated structurally, git enforces the rest of ref-name legality itself.
export const RefNameSchema = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
    .max(200);
// Exits rest DOWN by default, the opposite of a vpn's autoConnect. A vpn is dialled because something behind
// it is unreachable otherwise; an exit costs volunteer bandwidth (tor, vpngate) and buys nothing until a task
// actually wants a different country, so the honest default is to hold it until asked.
export const autoStart = z.enum(["on", "off"]).default("off");
