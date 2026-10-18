import { type DeviceSandbox, DeviceSandboxSchema } from "@intentic/sandbox-contract/schemas/devices";
import { z } from "zod";

// What a machine's own list_sandboxes tool answered, read the one way the device pull (device-reports.ts) reads it:
// the containers it listed, or why it listed none.

const DeviceSandboxRowsSchema = z.array(DeviceSandboxSchema);

// An answer this build cannot parse is no reading; JSON.parse throws nothing else for a string, and anything else is a bug.
const rowsOf = (text: string): DeviceSandbox[] | undefined => {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
    const rows = DeviceSandboxRowsSchema.safeParse(parsed);
    return rows.success ? rows.data : undefined;
};

// Containers come only through an approved host capability, never the sync agent. Reads the machine's own
// list_sandboxes tool; a refusal, a too-old agent or an answer this build cannot read is no reading, never "none there".
export const sandboxesFromTool = (text: string, refused: boolean): DeviceSandbox[] | undefined =>
    refused ? undefined : rowsOf(text.trim());

// Long enough for the machine's sentence and the reason it quotes; a usage dump after it is not for a card.
const UNREAD_MAX_CHARS = 300;

// Why a machine that answered did not list: the first line of its refusal or failure ("ic could not list this device's
// sandboxes: …", a switch that is off). Undefined for a listing, and for silence, which says nothing about why.
export const unreadFromTool = (text: string, refused: boolean): string | undefined => {
    const line = refused ? text.split(/\r?\n/).find((part) => part.trim() !== "")?.trim() : undefined;
    return line === undefined ? undefined : line.slice(0, UNREAD_MAX_CHARS);
};
