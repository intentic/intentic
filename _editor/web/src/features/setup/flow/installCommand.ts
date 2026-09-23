import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";

// The install command a reader pastes on their own machine: the setup code, plus what rides with it as environment
// (the own-zone Cloudflare token, the local-dev platform, this page's origin, the sync folder). Everything between the
// pipe and `sh` on unix; `$env:` assignments ahead of the script on Windows.

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
    // Root, which only installing Docker needs.
    readonly sudo: boolean;
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
    return `${input.sudo ? `sudo ` : ``}${envs === `` ? `` : `env${envs} `}`;
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

export const installCommand = (input: CommandInput): string =>
    input.os === `windows` ? psCommand(`ps1`, windowsEnv(input)) : bashCommand(`sh`, unixPrefix(input), input.code);

// The uninstaller offered beside it: removes every container, volume and network the install command creates.
export const uninstallCommand = (os: CommandInput[`os`]): string => (os === `windows` ? psCommand(`cleanupPs1`, ``) : bashCommand(`cleanup`, ``, ``));
