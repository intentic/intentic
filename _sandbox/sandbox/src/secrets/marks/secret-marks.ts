import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// A KEYED MARK OF A SECRET'S VALUE (schemas/secrets.ts SecretMarksResponseSchema): an HMAC of the name and the value
// under a random key this sandbox mints on first use and keeps in the auth root (mode 0600, off the file routes and the
// tree walk), so two marks compare equal exactly when the value is unchanged and say nothing about it to anyone without
// the key: never a plain hash, which a short or guessable value would give away. A managed deploy answers the marks of
// the values it filled (hosts/stacks/managed-deploy.ts), and `POST /secrets/marks` answers the current ones, so the
// Deployments extension can tell a stack's secret changed in the store without ever holding one. Moved here from the
// daemon's own deploy engine (2026-11-25), which kept each stack's marks beside the key; the extension keeps those now.

const SecretMarksKeySchema = z.object({
    // base64; empty until the first mark is made.
    key: z.string(),
});

export const secretMarksDocument = defineDocument({ root: "auth", path: "secret-marks.json", schema: SecretMarksKeySchema });

// Marks one named value; the name is marked with it, so one value under two names marks differently.
export type MarkOf = (name: string, value: string) => string;

export interface SecretMarks {
    // A mark maker under this sandbox's key, minting the key on first use.
    readonly marker: () => Promise<MarkOf>;
}

export const markerFor =
    (key: Buffer): MarkOf =>
    (name, value) =>
        createHmac("sha256", key).update(`${name}\u0000${value}`).digest("base64url");

export const fileSecretMarks = (path: string): SecretMarks => {
    const file = openDocument(secretMarksDocument, path, { fallback: () => ({ key: "" }), mode: 0o600 });
    return {
        marker: async () => {
            const { key } = await file.update((current) => (current.key === "" ? { key: randomBytes(32).toString("base64") } : current));
            return markerFor(Buffer.from(key, "base64"));
        },
    };
};

// The marks `POST /secrets/marks` answers: one per name this sandbox's own store holds, none for a name it does not (a
// connection's vault or a computer's keyring is never what a managed deploy fills, so it is never marked either).
export const marksOf = async (
    names: readonly string[],
    deps: { readonly marks: SecretMarks; readonly value: (name: string) => Promise<string | undefined> },
): Promise<Record<string, string>> => {
    const mark = await deps.marks.marker();
    const marks: Record<string, string> = {};
    for (const name of new Set(names)) {
        const value = await deps.value(name);
        if (value !== undefined) {
            marks[name] = mark(name, value);
        }
    }
    return marks;
};
