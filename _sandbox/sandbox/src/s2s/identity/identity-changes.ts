import { generateKeySet, generateRecoveryKey, normalizeDomain, recoveryKeyFromSecret, type S2sKeySet, txtRecordName, vouchFor } from "@intentic/sandbox-contract/s2s";
import { S2S_DOMAINS_MAX, type S2sIdentityPrev, type S2sMe } from "@intentic/sandbox-contract/schemas/s2s";
import { checkedRow, type DomainRow } from "./identity-domains.js";
import { keySetOf, storedOf, succeeded } from "./identity-keys.js";
import type { IdentityCore, IdentityRefusal, S2sIdentity, S2sRotation } from "./s2s-identity.js";

// What changes this sandbox's identity: claiming, dropping and checking its own domains, rotating its key, and the
// recovery key that can vouch for a new one after the volume holding the old one was lost.

type DomainChanges = Pick<S2sIdentity, "claimDomain" | "removeDomain" | "checkDomain" | "checkDomains">;
type KeyChanges = Pick<S2sIdentity, "rotate" | "mintRecovery" | "recover" | "onRotated">;

const notFound = (domain: string): IdentityRefusal => ({ refused: `${domain} is not claimed here`, status: 404 });

export const domainChanges = (core: IdentityCore): DomainChanges => {
    const { deps, domainsFile } = core;

    const expected = async (): Promise<{ readonly fingerprint: string; readonly host: string }> => ({
        fingerprint: keySetOf((await core.keys()).current).fingerprint,
        host: deps.self().host,
    });

    const check = async (row: DomainRow, against: { readonly fingerprint: string; readonly host: string }): Promise<void> => {
        const checked = checkedRow(row, await deps.resolveTxt(txtRecordName(row.domain)), against, deps.now());
        await domainsFile.update((file) => ({ domains: file.domains.map((other) => (other.domain === checked.domain ? checked : other)) }));
    };

    return {
        claimDomain: async (raw) => {
            const domain = normalizeDomain(raw);
            if (domain === undefined) {
                return { refused: `"${raw.slice(0, 80)}" is no domain: give it as ops.example.com, without a port`, status: 400 };
            }
            const file = await domainsFile.read();
            if (!file.domains.some((row) => row.domain === domain) && file.domains.length >= S2S_DOMAINS_MAX) {
                return { refused: `this sandbox already claims ${S2S_DOMAINS_MAX} domains`, status: 409 };
            }
            await domainsFile.update((current) =>
                current.domains.some((row) => row.domain === domain) ? current : { domains: [...current.domains, { domain, claimedAt: deps.now() }] },
            );
            return core.me();
        },
        removeDomain: async (domain) => {
            if (!(await domainsFile.read()).domains.some((row) => row.domain === domain)) {
                return notFound(domain);
            }
            await domainsFile.update((current) => ({ domains: current.domains.filter((row) => row.domain !== domain) }));
            return core.me();
        },
        checkDomain: async (domain) => {
            const row = (await domainsFile.read()).domains.find((candidate) => candidate.domain === domain);
            if (row === undefined) {
                return notFound(domain);
            }
            await check(row, await expected());
            return core.me();
        },
        // With no domain claimed it reads no keys, so a sandbox that never needed its identity makes none for this.
        checkDomains: async () => {
            const { domains } = await domainsFile.read();
            if (domains.length === 0) {
                return;
            }
            const against = await expected();
            for (const row of domains) {
                await check(row, against);
            }
        },
    };
};

export const keyChanges = (core: IdentityCore): KeyChanges => {
    const { deps, keysFile } = core;
    const listeners = new Set<(rotation: S2sRotation) => void>();

    const tell = (rotation: S2sRotation): void => {
        for (const listener of listeners) {
            try {
                listener(rotation);
            } catch (error) {
                deps.warn?.("s2s identity: a rotation listener threw", error instanceof Error ? error : new Error(String(error)));
            }
        }
    };

    // The current set replaced by a fresh one that `vouch` speaks for, then the contacts told.
    const succeed = async (by: S2sRotation["by"], vouch: (sandbox: string, next: S2sKeySet, at: number) => S2sIdentityPrev): Promise<S2sMe> => {
        const at = deps.now();
        const previous = (await core.keys()).current.fingerprint;
        const next = generateKeySet(deps.random);
        await keysFile.update((stored) => succeeded(stored, storedOf(next, at, vouch(deps.self().sandbox, next, at)), at));
        tell({ previous, document: await core.document(), by });
        return core.me();
    };

    return {
        rotate: async () => {
            const outgoing = keySetOf((await core.keys()).current);
            return succeed("key", (sandbox, next, at) => vouchFor(sandbox, next, { by: "key", keySet: outgoing }, at));
        },
        mintRecovery: async () => {
            await core.keys();
            const recovery = generateRecoveryKey(deps.random);
            await keysFile.update((stored) => ({ ...stored, recovery: { keys: recovery.public, fingerprint: recovery.fingerprint, createdAt: deps.now() } }));
            return { secret: recovery.secret, fingerprint: recovery.fingerprint };
        },
        recover: async (secret) => {
            const recovery = recoveryKeyFromSecret(secret);
            if (recovery === undefined) {
                return { refused: "that is no recovery key: one starts isrs1.", status: 400 };
            }
            const kept = (await keysFile.read()).recovery;
            if (kept !== undefined && kept.fingerprint !== recovery.fingerprint) {
                return { refused: `that recovery key is ${recovery.fingerprint}, not this sandbox's ${kept.fingerprint}`, status: 409 };
            }
            // A sandbox whose volume was lost has no record of it, so the pasted key is published again as its recovery key.
            const createdAt = kept?.createdAt ?? deps.now();
            await keysFile.update((stored) => ({ ...stored, recovery: { keys: recovery.public, fingerprint: recovery.fingerprint, createdAt } }));
            return succeed("recovery", (sandbox, next, at) => vouchFor(sandbox, next, { by: "recovery", recovery }, at));
        },
        onRotated: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
