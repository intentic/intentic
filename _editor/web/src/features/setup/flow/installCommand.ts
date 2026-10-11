import { DEFAULT_SYNC_ROOT, oneLinerFits, PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { bashCommand, oneLiner, psCommand } from "../../../app/environments/scriptCommand";

// The install command a reader pastes on their own device. Almost always the one-liner, `…/setup/<code>` (plus the
// sync folder's leaf, `…/setup/<code>/<leaf>`, while sync is on with a folder under ~/intentic). Only what that URL
// cannot carry keeps the older form with the values as environment: the own-zone Cloudflare token, the local-dev
// platform, a page origin other than the default, a sync folder somewhere else. Everything between the pipe and `sh`
// on unix; `$env:` assignments ahead of the script on Windows. Never `sudo`: connect.sh asks for root itself, at the
// one step that needs it.

// Locally built dev image; without it connect.sh pulls `:stable`, whose daemon predates unreleased routes.
export const DEV_SANDBOX_IMAGE = `intentic-sandbox:dev`;

export interface CommandInput {
    readonly os: `unix` | `windows`;
    readonly code: string;
    // The reader's own Cloudflare token, on the own-zone path only; it rides the command and is never stored.
    readonly cfToken: string | undefined;
    // The local-dev platform origin (`platformUrlOf`), which also brings the shared agent-auth volume.
    readonly platformUrl: string | undefined;
    // A dev build invoked by path, the only form with a checkout to build the dev image from.
    readonly fromCheckout: boolean;
    // This page's origin, where it is not the default the sandbox's CORS already allows (`webOriginOf`).
    readonly webOrigin: string | undefined;
    // The folder desktop sync mirrors, while sync is on.
    readonly syncDir: string | undefined;
}

// Local dev only: the localhost platform origin rides into the command; undefined for the hosted platform.
export const platformUrlOf = (apiUrl: string): string | undefined => {
    const api = new URL(apiUrl);
    if (api.hostname !== `localhost` && api.hostname !== `127.0.0.1`) {
        return undefined;
    }
    return api.origin;
};

// A page origin to send as WEB_ORIGIN, unless it is the default: any other is blocked by the sandbox's CORS.
export const webOriginOf = (origin: string): string | undefined => (origin === PLATFORM_WEB_ORIGIN ? undefined : origin);

const devEnv = ({ platformUrl, fromCheckout }: CommandInput): string =>
    platformUrl === undefined
        ? ``
        : ` PLATFORM_URL='${platformUrl}' INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'${fromCheckout ? ` SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'` : ``}`;

const devEnvPs = ({ platformUrl, fromCheckout }: CommandInput): string =>
    platformUrl === undefined
        ? ``
        : `$env:PLATFORM_URL='${platformUrl}'; $env:INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'; ${
              fromCheckout ? `$env:SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'; ` : ``
          }`;

// Everything between the pipe and `sh`: the runner, then one `env` carrying every assignment.
export const unixPrefix = (input: CommandInput): string => {
    const envs = [
        input.cfToken === undefined ? `` : ` CF_TOKEN='${input.cfToken}'`,
        devEnv(input),
        input.webOrigin === undefined ? `` : ` WEB_ORIGIN='${input.webOrigin}'`,
        input.syncDir === undefined ? `` : ` SYNC_DIR='${input.syncDir}'`,
    ].join(``);
    return envs === `` ? `` : `env${envs} `;
};

// The `$env:` assignments ahead of the script, the setup code last.
export const windowsEnv = (input: CommandInput): string =>
    [
        devEnvPs(input),
        input.webOrigin === undefined ? `` : `$env:WEB_ORIGIN='${input.webOrigin}'; `,
        input.cfToken === undefined ? `` : `$env:CF_TOKEN='${input.cfToken}'; `,
        input.syncDir === undefined ? `` : `$env:SYNC_DIR='${input.syncDir}'; `,
        `$env:SETUP_CODE='${input.code}'; `,
    ].join(``);

// The one-liner's arguments, or undefined where something rides that the URL cannot carry. The sync folder rides as its
// leaf only, and only under ~/intentic: the folder itself never goes through the platform.
export const setupOneLinerArgs = (input: CommandInput): readonly string[] | undefined => {
    if (input.cfToken !== undefined || input.platformUrl !== undefined || input.webOrigin !== undefined) {
        return undefined;
    }
    const leaf = input.syncDir?.startsWith(`${DEFAULT_SYNC_ROOT}/`) === true ? input.syncDir.slice(DEFAULT_SYNC_ROOT.length + 1) : undefined;
    if (input.syncDir !== undefined && leaf === undefined) {
        return undefined;
    }
    const args = leaf === undefined ? [input.code] : [input.code, leaf];
    return oneLinerFits(`setup`, args) ? args : undefined;
};

export const installCommand = (input: CommandInput): string => {
    const args = setupOneLinerArgs(input);
    if (args !== undefined) {
        return oneLiner(`setup`, args, input.os);
    }
    return input.os === `windows` ? psCommand(`ps1`, windowsEnv(input)) : bashCommand(`sh`, unixPrefix(input), input.code);
};

// The undo offered beside it: lists the sandboxes on the device and removes the one picked, recoverable for 7 days.
export const uninstallCommand = (os: CommandInput[`os`]): string => oneLiner(`remove`, [], os);
