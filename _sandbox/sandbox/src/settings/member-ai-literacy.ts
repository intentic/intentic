import { type AiLiteracyRecord, AiLiteracyRecordSchema } from "@intentic/sandbox-contract/schemas/ai-literacy";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// Confirmations belong to the daemon's history volume, never the agent's workspace.
export const memberAiLiteracyDocument = defineDocument({
    root: "history",
    path: "member-ai-literacy.json",
    // Who confirmed the AI notice, and which wording. Carried: it is the record an office
    // shows for the AI Act's literacy duty, and a move must not make everyone confirm again or lose who already did.
    portability: "carry",
    schema: z.object({ records: z.array(AiLiteracyRecordSchema) }),
});

export const fileMemberAiLiteracy = (path: string) => {
    const file = openDocument(memberAiLiteracyDocument, path, { fallback: () => ({ records: [] as AiLiteracyRecord[] }) });
    return {
        list: async (): Promise<AiLiteracyRecord[]> => (await file.read()).records,
        confirmedAt: async (member: string, version: string): Promise<string | undefined> =>
            (await file.read()).records.find((record) => record.member === member && record.version === version)?.confirmedAt,
        confirm: async (member: string, version: string): Promise<string> => {
            let confirmedAt = new Date().toISOString();
            await file.update((state) => {
                const held = state.records.find((record) => record.member === member && record.version === version);
                if (held !== undefined) {
                    confirmedAt = held.confirmedAt;
                    return state;
                }
                return { records: [...state.records, { member, version, confirmedAt }] };
            });
            return confirmedAt;
        },
    };
};
