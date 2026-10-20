import {
    PRIVACY_REPLACEMENTS_MAX,
    type PersonalDataClass,
    type PrivacyLedgerAction,
    type PrivacyLedgerEntry,
    PrivacyLedgerEntrySchema,
    type PrivacyReplacement,
} from "@intentic/sandbox-contract/schemas/privacy";
import { ownerTrusted, type ShieldVerdict } from "@intentic/sandbox-contract/schemas/privacy-egress";
import { defineDocument } from "../store/evolution/documents.js";
import { boundedLog } from "../store/json-file.js";
import { opt } from "../opt.js";
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

// What one seam did with one egress, as it tells the log: the gateway for a request, the MCP proxy for a tool's answer,
// a hooked runtime's channel or a sealed prompt for its text. `verdict` is the one it acted on, which says whether the
// provider was the owner's to trust.
export interface EgressNote {
    readonly provider: string;
    readonly conversationId?: string | undefined;
    readonly verdict: ShieldVerdict;
    readonly action: PrivacyLedgerAction;
    readonly protocol: string;
    readonly counts?: Partial<Record<PersonalDataClass, number>> | undefined;
    readonly images?: number | undefined;
    readonly documents?: number | undefined;
    readonly replacements?: readonly PrivacyReplacement[] | undefined;
    readonly detail?: string | undefined;
}

// The log's one writer, on the side: a line it lost costs the request nothing, so a failed write is only said.
export const noteEgress = (ledger: PrivacyLedger, note: EgressNote, warn: (message: string) => void, at = new Date()): void => {
    const replacements = note.replacements?.slice(0, PRIVACY_REPLACEMENTS_MAX) ?? [];
    void ledger
        .record({
            at: at.toISOString(),
            ...opt("conversationId", note.conversationId),
            provider: note.provider,
            trusted: ownerTrusted(note.verdict),
            action: note.action,
            counts: note.counts ?? {},
            images: note.images ?? 0,
            documents: note.documents ?? 0,
            protocol: note.protocol,
            ...opt("detail", note.detail),
            ...opt("replacements", replacements.length > 0 ? replacements : undefined),
        })
        .catch((error: Error) => warn(`privacy shield: the log could not be written (${error.message})`));
};
