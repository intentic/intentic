import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";

// WHICH SECRET VALUES EACH MANAGED STACK RUNS WITH, AS MARKS (deploy-rotation.ts reads them): for every stack, an HMAC
// of each value its last successful deploy received, and of each changed value the owner was already told of or a
// redeploy was started for. The key is random, this sandbox's own, and kept beside the marks in the auth root (mode
// 0600, off the file routes and the tree walk), so a mark says whether a value changed and nothing about the value:
// never a plain hash, which a short or guessable value would give away to anyone reading the file.

const StackMarksSchema = z.object({
    repo: z.string(),
    stack: z.string(),
    // Secret name → the mark of the value its last successful deploy rendered.
    deployed: z.record(z.string(), z.string()),
    // Secret name → the mark of a changed value already acted on (told, or redeployed for), so it is acted on once.
    told: z.record(z.string(), z.string()).default({}),
});
export type StackMarks = z.infer<typeof StackMarksSchema>;

const SecretMarksFileSchema = z.object({
    // base64; empty until the first mark is written.
    key: z.string(),
    stacks: z.array(StackMarksSchema).default([]),
});
type SecretMarksFile = z.infer<typeof SecretMarksFileSchema>;

export const deploySecretMarksDocument = defineDocument({ root: "auth", path: "deploy-secret-marks.json", schema: SecretMarksFileSchema });

// What a secret the store no longer holds marks as: no HMAC ever reads so.
const ABSENT = "absent";

export interface SecretMarks {
    // A mark maker under this sandbox's key, minting the key on first use.
    readonly marker: () => Promise<(name: string, value: string | undefined) => string>;
    readonly all: () => Promise<readonly StackMarks[]>;
    // The stack's marks changed in place; a stack none are kept for starts from none.
    readonly change: (repo: string, stack: string, change: (current: StackMarks) => StackMarks) => Promise<void>;
}

const keyed = (file: SecretMarksFile): SecretMarksFile => (file.key === "" ? { ...file, key: randomBytes(32).toString("base64") } : file);

export const fileSecretMarks = (path: string): SecretMarks => {
    const file = openDocument(deploySecretMarksDocument, path, { fallback: () => ({ key: "", stacks: [] }), mode: 0o600 });
    return {
        marker: async () => {
            const key = Buffer.from((await file.update(keyed)).key, "base64");
            // The name is marked with the value, so one value under two names marks differently.
            return (name, value) => (value === undefined ? ABSENT : createHmac("sha256", key).update(`${name}\u0000${value}`).digest("base64url"));
        },
        all: async () => (await file.read()).stacks,
        change: async (repo, stack, change) => {
            await file.update((current) => {
                const held = current.stacks.find((entry) => entry.repo === repo && entry.stack === stack) ?? { repo, stack, deployed: {}, told: {} };
                const others = current.stacks.filter((entry) => entry !== held);
                return { ...current, stacks: [...others, change(held)] };
            });
        },
    };
};
