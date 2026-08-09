import type { AccessLevel } from "./accounts.js";

/* WHAT THE CARD'S READ-ONLY SWITCH ACTUALLY BUYS.
 *
 * Two lists, not one list plus a runtime check, because the two halves fail differently and both are needed:
 * the scope set is what Google itself will enforce (a read-only grant cannot send mail however wrong this
 * process gets), and the `writes` flag on each command is what makes the refusal legible — "this connection
 * is read-only" instead of a 403 from an API the owner never named.
 *
 * Only the DOMAIN flow and `gw auth login` send these; a user connection's scopes were fixed when the owner
 * approved the consent screen, and its refresh token carries them. So a user card switched to read-only after
 * the fact still holds a write-capable token — which is exactly why the command-level guard exists too. */

const BASE = "https://www.googleapis.com/auth/";

const WRITE = ["gmail.modify", "gmail.send", "calendar", "drive", "documents", "spreadsheets", "contacts"];
const READ = ["gmail.readonly", "calendar.readonly", "drive.readonly", "documents.readonly", "spreadsheets.readonly", "contacts.readonly"];

export const scopesFor = (access: AccessLevel): string[] => (access === "read" ? READ : WRITE).map((scope) => `${BASE}${scope}`);
