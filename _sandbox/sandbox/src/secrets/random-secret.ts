import { randomBytes, randomInt } from "node:crypto";
import type { SECRET_FORMATS } from "@intentic/sandbox-contract";

// The value `secrets generate` stores (secrets.routes.ts): `bytes` of randomness from the OS, spelled the way the reader
// needs it. Never logged and never returned; only its length leaves.

export type SecretFormat = (typeof SECRET_FORMATS)[number];

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const randomSecret = (bytes: number, format: SecretFormat): string => {
    switch (format) {
        case "hex":
            return randomBytes(bytes).toString("hex");
        case "base64url":
            return randomBytes(bytes).toString("base64url");
        case "alnum": {
            // As many characters as carry the same randomness, log2(62) bits each; randomInt draws without modulo bias.
            const length = Math.ceil((bytes * 8) / Math.log2(ALNUM.length));
            return Array.from({ length }, () => ALNUM[randomInt(ALNUM.length)]).join("");
        }
    }
};
