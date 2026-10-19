// Named imports rather than the `z` namespace, and nothing from schemas/keyring.ts: this module is bundled into the
// browser extension, where the namespace keeps zod's locales (~330 kB) that esbuild can otherwise drop
// (_devices/webext/scripts/size-budget.mjs holds the ceiling). The three schemas it shares with keyring.ts are spelled
// again below, and keyring-native.test.ts holds them equal.
import { array, boolean, discriminatedUnion, enum as zEnum, literal, number, object, string, union } from "zod";
import type * as z from "zod";

// What the browser extension and `intentic-keyring native-host` say to each other over Chrome's native messaging: one
// JSON message each way per request, length-prefixed by the browser, correlated by `id`. The native host is a process
// the browser starts as the person's user; it seals a captured value to the vault's inbox key before it reaches the
// keyring's pipe, and asks the keyring (which asks the person, with Windows Hello or polkit) before any value goes back
// to the page. A site's host, never a full address, is all the extension ever names.
//
// `@intentic/sandbox-contract/webext` re-exports it.

/** The name the extension connects to (`chrome.runtime.connectNative`), and the native host's manifest declares. */
export const KEYRING_NATIVE_HOST = "dev.intentic.keyring";

const id = string().min(1).max(64);
const host = string().min(1).max(253);

/** keyring.ts's secret name, refusal code and capture outcome, as the extension sees them. */
export const KeyringNativeNameSchema = string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
export const KeyringNativeRefusalCodeSchema = zEnum([
    "no-keyring",
    "locked",
    "declined",
    "unknown",
    "not-shared",
    "bad-grant",
    "expired",
    "replayed",
    "guard",
    "unavailable",
    "busy",
    "pending",
]);
export const KeyringNativeOutcomeSchema = zEnum(["saved", "updated", "unchanged", "pending", "skipped"]);

export const KeyringNativeRequestSchema = discriminatedUnion("type", [
    // What the extension needs before it shows anything: whether remembering is on for browsers, and the vault's state.
    object({
        type: literal("hello"),
        id,
        browser: string().min(1).max(100).describe("The browser's own name, `Brave`, for the title line."),
    }).strict(),
    // A sign-in, sign-up or password change the page just submitted.
    object({
        type: literal("capture"),
        id,
        browser: string().min(1).max(100),
        host,
        username: string().max(256).optional(),
        password: string().min(1).max(4096),
        title: string().max(200).optional().describe("The site's own name (`og:site_name`, the title), when it has one."),
        failed: boolean().optional().describe("The form came back for the same user: the last value saved for it did not work."),
    }).strict(),
    // What the keyring holds for this site: names, titles and users, never values.
    object({ type: literal("candidates"), id, host }).strict(),
    // One entry's value for the focused field, after the person's yes at the computer.
    object({ type: literal("fill"), id, host, name: KeyringNativeNameSchema }).strict(),
    // Take back a capture made moments ago (the toast's Undo).
    object({ type: literal("undo"), id, name: KeyringNativeNameSchema, at: number().int() }).strict(),
    // Never save for this site (the toast's "Never for this site").
    object({ type: literal("never"), id, host }).strict(),
]);
export type KeyringNativeRequest = z.infer<typeof KeyringNativeRequestSchema>;

const refused = object({ ok: literal(false), code: KeyringNativeRefusalCodeSchema, refusal: string() });

export const KeyringNativeCandidateSchema = object({ name: KeyringNativeNameSchema, title: string(), username: string().optional() });
export type KeyringNativeCandidate = z.infer<typeof KeyringNativeCandidateSchema>;

// A plain union: a refusal shares its `type` with the answer it stands in for, which a discriminated union cannot hold.
export const KeyringNativeResponseSchema = union([
    object({
        type: literal("hello"),
        id,
        ok: literal(true),
        setUp: boolean(),
        locked: boolean(),
        remember: boolean().describe("Whether the person turned on remembering for browsers."),
        version: string(),
    }),
    object({
        type: literal("capture"),
        id,
        ok: literal(true),
        outcome: KeyringNativeOutcomeSchema,
        name: KeyringNativeNameSchema.optional(),
        title: string().optional(),
        at: number().int(),
    }),
    object({ type: literal("candidates"), id, ok: literal(true), items: array(KeyringNativeCandidateSchema) }),
    object({ type: literal("fill"), id, ok: literal(true), username: string().optional(), password: string() }),
    object({ type: literal("undo"), id, ok: literal(true) }),
    object({ type: literal("never"), id, ok: literal(true) }),
    // Any request refused, under the type it was asked as.
    refused.extend({ type: zEnum(["hello", "capture", "candidates", "fill", "undo", "never"]), id }),
]);
export type KeyringNativeResponse = z.infer<typeof KeyringNativeResponseSchema>;
