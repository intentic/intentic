// Compose variant of the setup one-liner: a one-time bootstrap writes `.env` beside the user's compose file,
// then `docker compose up -d`; no tunnel is minted separately. The file is the run contract's own Compose rendering, so
// a sandbox can move between script-managed and compose-managed without losing /work.

import { PLATFORM_API_DEFAULT, type SetupComposeArgs, setupComposeFile } from "@intentic/sandbox-run/compose";

export interface ComposeArgs {
    // The short-lived setup code the platform minted, the only secret-adjacent value in the instructions.
    readonly code: string;
    // The sandbox's public hostname (<slug>.<zone>) the chosen target resolved to.
    readonly hostname: string;
    // Cloudflare API token (own path only): appended to .env, never sent to the platform.
    readonly image: string;
    readonly googleClientId: string;
    // Origin the setup page is served from; mirrors WEB_ORIGIN, shown only when it differs from the hosted default.
    readonly webOrigin: string;
    // Local dev only: the localhost platform origin; production leaves it undefined (api.intentic.dev).
    readonly platformUrl?: string | undefined;
}

const isLocal = (url: string): boolean => url.includes(`//localhost`) || url.includes(`//127.0.0.1`);

// One-time bootstrap run beside the compose file: the claim consumes the setup code and writes per-sandbox
// values as .env lines, then compose starts the sandbox with them.
export const composeBootstrap = (args: ComposeArgs): string => {
    const platform = args.platformUrl ?? PLATFORM_API_DEFAULT;
    // Local dev only: the dev platform's cert is a repo CA the system doesn't trust (same as connect.sh).
    const claim = `curl -fsS${isLocal(platform) ? `k` : ``} ${platform}/setup/claim -d code=${args.code} > .env`;
    return `${claim}\ndocker compose up -d`;
};

// What the rebuild card adds to the setup page's file: the approved recipe Compose builds, and storage that exists.
type ComposeRebuildArgs = Pick<SetupComposeArgs, `recipe` | `existingStorage`>;

// The sandbox's Compose file: the run contract's own rendering of a new sandbox (@intentic/sandbox-run/compose), which
// the docs quickstart shows too. Credentials stay in .env; non-secret identity is rendered concretely.
export const composeFile = (args: Omit<ComposeArgs, `code`> & ComposeRebuildArgs): string => setupComposeFile(args);
