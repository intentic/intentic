import { createHash } from "node:crypto";
import type { Config } from "../../../config.js";

// Deployment identity: API URL plus the database's host and path, never the credential (plaintext at the provider) — a
// copied env file pointed at a different database is a different deployment. `HOSTED_INSTANCE_ID` overrides this
// derivation.
const instanceFingerprint = (config: Config): string => {
    const raw = config.database?.url ?? ``;
    try {
        const dsn = new URL(raw);
        return `${config.api.url}|${dsn.host}${dsn.pathname}`;
    } catch {
        // Unparsable DSN (empty config in tests): fall back so a bad URL doesn't take the whole lane down.
        return `${config.api.url}|`;
    }
};

export const hostedInstanceId = (config: Config): string => {
    // `?? ''` guards against undefined comparing unequal to every stored stamp (reads as "none of these are mine").
    const override = config.hosted.instanceId ?? ``;
    return override === `` ? createHash(`sha256`).update(instanceFingerprint(config)).digest(`hex`).slice(0, 12) : override;
};
