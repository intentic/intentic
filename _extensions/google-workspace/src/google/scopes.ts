import type { AccessLevel } from "./accounts.js";

// What the card's read-only switch buys. Two lists, not one plus a check: Google enforces the scope set itself, while
// the `writes` flag on each command makes the refusal legible. A user card switched to read-only after consent still
// holds a write-capable token, which is why the command-level guard also exists.

const BASE = "https://www.googleapis.com/auth/";

const WRITE = ["gmail.modify", "gmail.send", "calendar", "drive", "documents", "spreadsheets", "contacts"];
const READ = ["gmail.readonly", "calendar.readonly", "drive.readonly", "documents.readonly", "spreadsheets.readonly", "contacts.readonly"];

export const scopesFor = (access: AccessLevel): string[] => (access === "read" ? READ : WRITE).map((scope) => `${BASE}${scope}`);
