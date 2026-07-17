// The user-facing host name can look like a machine name ("home-server"), but the
// generated deploy.config.ts still needs a TypeScript/env-safe inventory id.
export const normalizeHostName = (value: string): string => {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, `_`);
    if (normalized === ``) {
        return ``;
    }
    const identifier = /^[0-9]/.test(normalized) ? `_${normalized}` : normalized;
    return identifier === `self` ? `host` : identifier;
};

// The zone the sandbox tunnel lives under is derived by the shared `zoneFromUrl` in @intentic/sandbox-contract
// (the single implementation the daemon + web + CLI agree on) — import it from there directly.
