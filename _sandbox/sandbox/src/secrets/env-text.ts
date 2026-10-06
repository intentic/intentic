import { parseEnv } from "node:util";
import { envLine } from "@intentic/sandbox-run/quote";

// A .env file's text, edited as text: the one place its keys are added, replaced, dropped and listed, so the secrets
// routes, the needs answer, host enrolment and the assistant importers all write a .env the same way. Kept out of the
// routes module so the code that writes a .env does not have to import the HTTP layer to do it.

// Upserts by parsing and re-serializing via `envLine`, not string interpolation, so a value containing a quote or
// newline (an SSH key) cannot break out of its line or inject a second key.
export const upsertEnv = (content: string, key: string, value: string): string => {
    // SAFETY: parseEnv answers a Dict whose present keys all hold strings; a missing key is not enumerated, so the
    // undefined its type admits never reaches the spread.
    const entries = { ...(parseEnv(content) as Record<string, string>), [key]: value };
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => envLine(entryKey, entryValue))
        .join("");
};

// Drops KEY from a .env's text (same parse/re-serialize round-trip as upsertEnv).
export const removeEnv = (content: string, key: string): string => {
    // SAFETY: as in upsertEnv, every enumerated key of parseEnv's Dict holds a string.
    const entries = parseEnv(content) as Record<string, string>;
    delete entries[key];
    return Object.entries(entries)
        .map(([entryKey, entryValue]) => envLine(entryKey, entryValue))
        .join("");
};

// The keys present in a .env's text (for the UI's set badges), never the values.
export const envKeys = (content: string): string[] => Object.keys(parseEnv(content));
