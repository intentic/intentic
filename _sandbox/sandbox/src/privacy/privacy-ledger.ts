import { type PrivacyLedgerEntry, PrivacyLedgerEntrySchema } from "@intentic/sandbox-contract";
import { defineDocument } from "../store/evolution/documents.js";
import { boundedLog } from "../store/json-file.js";
import { openEntries } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// What the gateway did with each model request, newest first: which provider, whether it was trusted, and how many of
// each kind it found in what the request added. Never a value, so it can sit in the workspace beside the safety log and
// be read by anybody who can read that. It is how watch mode earns its keep: the owner sees what would have reached
// each provider before deciding to mask.

export const privacyLedgerDocument = defineDocument({
    path: stateRelPath(".intentic/local/privacy-log.json"),
    schema: PrivacyLedgerEntrySchema,
    granularity: "entries",
});

// A busy afternoon of several conversations; old enough entries say nothing a new one would not.
const KEPT = 500;

export interface PrivacyLedger {
    readonly recent: () => Promise<PrivacyLedgerEntry[]>;
    readonly record: (entry: PrivacyLedgerEntry) => Promise<void>;
}

export const filePrivacyLedger = (path: string): PrivacyLedger => {
    const log = boundedLog(openEntries(privacyLedgerDocument, path), KEPT);
    return {
        recent: async () => [...(await log.read())].sort((left, right) => right.at.localeCompare(left.at)),
        record: (entry) => log.append(entry),
    };
};
