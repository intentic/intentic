import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseJsonOr } from "@intentic/base/json";
import { cliProxyIdOf } from "@intentic/sandbox-contract/models/provider-specs";
import { type KeyedProvider, KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { TranslatorAuthFile } from "../../usage/translator-usage.js";
import { opt } from "../../opt.js";

// The translator's credential files as they sit in its auth dir, read without asking the proxy: who holds which
// subscription while the proxy boots or restarts, and the one field its Management API listing leaves out, the prefix
// that pins a request to one of them (translator-prefixes.ts).

// The subscription-token store; survives sandbox rebuilds alongside the other AI-provider credentials.
export const cliProxyAuthDir = (authRoot: string): string => join(authRoot, "cliproxy");

// What an auth file on disk stamps itself with (CLIProxyAPI's id: xai, antigravity), back to our provider id.
const KEYED_PROVIDER: ReadonlyMap<string, KeyedProvider> = new Map(
    KeyedProviderSchema.options.map((provider) => [cliProxyIdOf(provider) ?? provider, provider] as const),
);

// The fields of one auth file this reads, each dropped rather than failing the file when it is not what it should be;
// anything else in it is the proxy's.
const OnDiskSchema = z.object({
    type: z.string().optional().catch(undefined),
    email: z.string().optional().catch(undefined),
    project_id: z.string().optional().catch(undefined),
    disabled: z.boolean().optional().catch(undefined),
    prefix: z.string().optional().catch(undefined),
});
type OnDisk = z.infer<typeof OnDiskSchema>;

// One parsed file as the Management API's row would carry it, plus its prefix, which only the file holds. Shaped like
// the Management API's row; `auth_index` is absent, only the proxy can supply it. `project_id` is carried because a
// Google credential is judged on it, and reading a file as project-less for the sole reason that the proxy is down
// would bench every Google account at once. `disabled` persists into the file, so a credential already taken out of the
// rotation still reads as benched here.
const rowOf = (name: string, parsed: OnDisk): TranslatorAuthFile[] => {
    if (parsed.type === undefined || !KEYED_PROVIDER.has(parsed.type)) {
        return [];
    }
    const prefix = parsed.prefix?.trim();
    return [
        {
            name,
            provider: parsed.type,
            ...opt("email", parsed.email),
            ...opt("project_id", parsed.project_id),
            ...opt("disabled", parsed.disabled === true ? true : undefined),
            ...opt("prefix", prefix === "" ? undefined : prefix),
        },
    ];
};

// Connection view that doesn't need a running proxy: reads subscriptions off the auth-dir, for callers when the proxy
// can't be asked (before it exists, or while down). A stale credential still counts as connected.
export const authFilesOnDisk = async (authDir: string): Promise<TranslatorAuthFile[]> => {
    // allow(silent-catch): an auth-dir that cannot be listed (not created yet: nothing signed in) holds no subscriptions.
    const names = (await readdir(authDir).catch(() => [])).filter((name) => name.endsWith(".json"));
    const files = await Promise.all(
        names.map(async (name): Promise<TranslatorAuthFile[]> => {
            // allow(silent-catch): a file gone or unreadable mid-read counts as not there, and is read again next time.
            const raw = await readFile(join(authDir, name), "utf8").catch(() => undefined);
            const parsed = OnDiskSchema.safeParse(raw === undefined ? undefined : parseJsonOr(raw, undefined));
            // Unread, or half-written by a login still polling: it counts on the next read.
            return parsed.success ? rowOf(name, parsed.data) : [];
        }),
    );
    return files.flat();
};

export const connectedTranslatorProviders = async (authRoot: string): Promise<Set<KeyedProvider>> => {
    const files = await authFilesOnDisk(cliProxyAuthDir(authRoot));
    return new Set(
        files.flatMap((file) => {
            const keyed = file.provider === undefined ? undefined : KEYED_PROVIDER.get(file.provider);
            return keyed === undefined ? [] : [keyed];
        }),
    );
};
