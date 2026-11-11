// What the Google Workspace card asks Google for, in one place for the three parties that ask: the platform's own OAuth
// client behind the card's Connect Google button, `gw auth login` on a client the owner brought, and a company
// service account's delegated token. Two lists, not one plus a check: Google enforces the scope set itself, while the
// `writes` flag on each `gw` command makes the refusal legible.

export type GoogleAccess = "read" | "write";

const BASE = "https://www.googleapis.com/auth/";

const WRITE = ["gmail.modify", "gmail.send", "calendar", "drive", "documents", "spreadsheets", "contacts"];
const READ = ["gmail.readonly", "calendar.readonly", "drive.readonly", "documents.readonly", "spreadsheets.readonly", "contacts.readonly"];

export const googleWorkspaceScopes = (access: GoogleAccess): string[] => (access === "read" ? READ : WRITE).map((scope) => `${BASE}${scope}`);

// Added to a sign-in so the token answer names the account it was made for, which fills the card's address.
export const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;
