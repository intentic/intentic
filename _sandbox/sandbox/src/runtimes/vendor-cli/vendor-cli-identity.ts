import { readFile } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";
import type { CliIdentity } from "./vendor-cli.js";

// Who a CLI's fresh sign-in belongs to, read off the token file its login wrote: an `email` the file states outright, or
// the one an OpenID token in it carries (both vendors' sign-ins are OAuth, and an ID token's claims are signed by the
// vendor, not secret). Read once, into the account's row; the daemon spends nothing from the file.

const ClaimsSchema = z.object({ email: z.string().email() });

// A JWT's claims, or nothing for a string that is not one.
const claimsOf = (token: string): z.infer<typeof ClaimsSchema> | undefined => {
    const payload = token.split(".")[1];
    if (payload === undefined || !/^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token)) {
        return undefined;
    }
    try {
        return ClaimsSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).data;
    } catch {
        // allow(silent-catch): a three-part string whose middle is not JSON is not a token, which reads as no identity
        return undefined;
    }
};

const JsonSchema: z.ZodType<Json> = z.lazy(() =>
    z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonSchema), z.record(z.string(), JsonSchema)]),
);
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const ListSchema = z.array(JsonSchema);
const RecordSchema = z.record(z.string(), JsonSchema);

// The first email the document names, depth first: an `email` key, else a token whose claims carry one.
export const emailIn = (document: Json): string | undefined => {
    const token = z.string().safeParse(document);
    if (token.success) {
        return claimsOf(token.data)?.email;
    }
    const record = RecordSchema.safeParse(document);
    const named = record.success ? ClaimsSchema.safeParse(record.data).data?.email : undefined;
    if (named !== undefined) {
        return named;
    }
    const values = record.success ? Object.values(record.data) : (ListSchema.safeParse(document).data ?? []);
    for (const value of values) {
        const found = emailIn(value);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
};

// The first of these files (JSON) that names an email; none that do is a nameless sign-in.
export const identityIn = async (paths: readonly string[]): Promise<CliIdentity> => {
    for (const path of paths) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- the first file that answers wins; the rest go unread
        const text = await readFile(path, "utf8").catch(undefinedIfMissing);
        const parsed = text === undefined ? undefined : JsonSchema.safeParse(JSON.parse(text)).data;
        const email = parsed === undefined ? undefined : emailIn(parsed);
        if (email !== undefined) {
            return { email };
        }
    }
    return {};
};
