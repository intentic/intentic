import { createHash } from "node:crypto";
import type { Logger } from "pino";
import type { TranslatorAuthFile } from "../../usage/translator-usage.js";

/* EACH TRANSLATOR CREDENTIAL CARRIES A PREFIX OF ITS OWN, so the daemon can send a request to that one credential and no
   other. CLIProxyAPI registers every model of a credential whose `prefix` is P a second time, as `P/<model>`, and serves
   a request for `P/<model>` on that credential alone, the prefix stripped before it goes upstream; the bare model id
   keeps reaching every credential, as before. The daemon's translator gateway (translator-gateway.ts) asks for
   `P/<model>` on the account it picked, so a refusal comes back from a known account.

   The prefix is the file name's, hashed, so it is the same on every boot and survives a re-sign-in (the proxy keeps a
   credential's prefix when its login refreshes the file). It is set over the Management API, which persists it into the
   file; the API's listing does not show it, so the file on disk is where it is read back (translator-auth-files.ts).
   Best effort: a credential the proxy would not take one on stays unpinned, its requests unpinned, and its failure is
   reported once. */

// How many hex digits of the name's hash the prefix keeps: enough that a sandbox's few dozen files never collide.
const PREFIX_HEX_DIGITS = 10;

/** The prefix that pins a request to the credential in this file. */
export const accountPrefix = (name: string): string => `ic-${createHash("sha1").update(name).digest("hex").slice(0, PREFIX_HEX_DIGITS)}`;

/** What one round of giving credentials their prefixes changed: the ones it gave one, and the ones newly refused one. */
export interface PinReport {
    readonly pinned: readonly string[];
    readonly failed: readonly { readonly name: string; readonly reason: string }[];
}

export interface AccountPinning {
    // Gives every credential lacking its prefix (or carrying another) its own. A round younger than `maxAgeMs` is not
    // run again; one already running is joined. A failure is reported by the first round that meets it, not again
    // until a round has pinned that credential since.
    readonly pin: (options?: { readonly maxAgeMs?: number }) => Promise<PinReport>;
    // The prefix of a credential known to carry it, as of the last round: its file said so, or the proxy took it then.
    readonly prefixOf: (name: string) => string | undefined;
}

const NOTHING: PinReport = { pinned: [], failed: [] };

export const createAccountPinning = (params: {
    readonly managementUrl: string;
    readonly auth: Readonly<Record<string, string>>;
    // Every credential file of a provider the translator routes, with the prefix its file carries.
    readonly files: () => Promise<readonly TranslatorAuthFile[]>;
    readonly fetchFn: typeof fetch;
    readonly now?: () => number;
}): AccountPinning => {
    const { managementUrl, auth, fetchFn } = params;
    const now = params.now ?? Date.now;
    const known = new Map<string, string>();
    const reported = new Set<string>();
    let lastAt: number | undefined;
    let running: Promise<PinReport> | undefined;

    // One credential's prefix set on the proxy, or why not.
    const patch = async (name: string, prefix: string): Promise<string | undefined> => {
        try {
            const response = await fetchFn(`${managementUrl}/auth-files/fields`, {
                method: "PATCH",
                headers: { ...auth, "content-type": "application/json" },
                body: JSON.stringify({ name, prefix }),
            });
            // allow(silent-catch): a refusal whose body cannot be read is still reported, by its status.
            return response.ok ? undefined : `the translator answered ${String(response.status)}: ${(await response.text().catch(() => "")).slice(0, 200)}`;
        } catch (error) {
            return error instanceof Error ? error.message : "the translator could not be reached";
        }
    };

    const round = async (): Promise<PinReport> => {
        const files = (await params.files()).flatMap((file) => (file.name === undefined ? [] : [{ name: file.name, prefix: file.prefix }]));
        const pinned: string[] = [];
        const failed: { name: string; reason: string }[] = [];
        for (const name of known.keys()) {
            if (!files.some((file) => file.name === name)) {
                known.delete(name);
            }
        }
        await Promise.all(
            files.map(async (file) => {
                const prefix = accountPrefix(file.name);
                // The file is the record: one that lost its prefix (rewritten by hand, say) is given it again.
                if (file.prefix === prefix) {
                    known.set(file.name, prefix);
                    return;
                }
                const refused = await patch(file.name, prefix);
                if (refused === undefined) {
                    known.set(file.name, prefix);
                    reported.delete(file.name);
                    pinned.push(file.name);
                    return;
                }
                known.delete(file.name);
                if (!reported.has(file.name)) {
                    reported.add(file.name);
                    failed.push({ name: file.name, reason: refused });
                }
            }),
        );
        lastAt = now();
        return { pinned, failed };
    };

    return {
        pin: async (options = {}) => {
            if (running !== undefined) {
                return running;
            }
            if (lastAt !== undefined && options.maxAgeMs !== undefined && now() - lastAt < options.maxAgeMs) {
                return NOTHING;
            }
            running = round().finally(() => {
                running = undefined;
            });
            return running;
        },
        prefixOf: (name) => known.get(name),
    };
};

/** Says what a round changed: each credential pinned, and each one the proxy refused a prefix, whose requests go unpinned. */
export const logPins = (logger: Pick<Logger, "info" | "warn">, report: PinReport): void => {
    if (report.pinned.length > 0) {
        logger.info({ accounts: report.pinned }, "translator: credentials pinned, each now reachable on its own prefix");
    }
    if (report.failed.length > 0) {
        logger.warn({ accounts: report.failed }, "translator: credentials the proxy refused a prefix; requests on them go unpinned");
    }
};
