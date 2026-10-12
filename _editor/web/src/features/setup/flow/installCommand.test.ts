import { installScriptUrl, PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { bashCommand, psCommand, scriptSource } from "../../../app/environments/scriptCommand";
import { type CommandInput, installCommand, platformUrlOf, setupOneLinerArgs, uninstallCommand, unixPrefix, webOriginOf, windowsEnv } from "./installCommand";

// Pins the setup command: the one-liner wherever the URL can carry everything (the code, and the sync folder's leaf
// under ~/intentic), and otherwise what rides with the setup code, in the order each shell receives it: the own-zone
// token, the local-dev platform (and its image only from a checkout), this page's origin where it is not the default,
// and the sync folder. Never root: connect.sh asks for it itself.

beforeEach(() => {
    scriptSource.value = `published`;
});

const bare: CommandInput = {
    os: `unix`,
    code: `vphf3wkQ7xK`,
    cfToken: undefined,
    platformUrl: undefined,
    fromCheckout: false,
    webOrigin: undefined,
    syncDir: undefined,
};
const loaded: CommandInput = {
    ...bare,
    cfToken: `cf-token`,
    platformUrl: `https://localhost:6480`,
    fromCheckout: true,
    webOrigin: `https://app.example.dev`,
    syncDir: `~/intentic/workspace`,
};

describe(`the one-liner`, () => {
    it(`is the whole command when only the code rides`, () => {
        expect(installCommand(bare)).toBe(`curl -fsSL https://intentic.dev/setup/vphf3wkQ7xK | sh`);
        expect(installCommand({ ...bare, os: `windows` })).toBe(`irm https://intentic.dev/setup/vphf3wkQ7xK | iex`);
    });

    it(`carries a default sync folder as its leaf`, () => {
        const synced = { ...bare, syncDir: `~/intentic/my-project-ab12` };
        expect(setupOneLinerArgs(synced)).toEqual([`vphf3wkQ7xK`, `my-project-ab12`]);
        expect(installCommand(synced)).toBe(`curl -fsSL https://intentic.dev/setup/vphf3wkQ7xK/my-project-ab12 | sh`);
    });

    it(`runs the checkout's script by path in a dev build set to it`, () => {
        scriptSource.value = `checkout`;
        expect(installCommand({ ...bare, syncDir: `~/intentic/proj` })).toBe(
            `env SYNC_DIR='~/intentic/proj' sh _site/site/public/scripts/connect.sh 'vphf3wkQ7xK'`,
        );
        expect(installCommand({ ...bare, os: `windows`, syncDir: `~/intentic/proj` })).toBe(
            `& ./_site/site/public/scripts/connect.ps1 -SetupCode 'vphf3wkQ7xK' -SyncDir '~/intentic/proj'`,
        );
    });

    it(`gives way to the environment form for what the URL cannot carry`, () => {
        expect(setupOneLinerArgs({ ...bare, cfToken: `cf-token` })).toBe(undefined);
        expect(setupOneLinerArgs({ ...bare, platformUrl: `https://localhost:6480` })).toBe(undefined);
        expect(setupOneLinerArgs({ ...bare, webOrigin: `https://app.example.dev` })).toBe(undefined);
        expect(setupOneLinerArgs({ ...bare, syncDir: `~/Projects/mine` })).toBe(undefined);
        expect(setupOneLinerArgs({ ...bare, syncDir: `~/intentic/My Folder` })).toBe(undefined);
        expect(installCommand({ ...bare, syncDir: `~/Projects/mine` })).toBe(bashCommand(`sh`, `env SYNC_DIR='~/Projects/mine' `, `vphf3wkQ7xK`));
    });
});

describe(`the unix command`, () => {
    it(`puts every assignment on one env, token, platform, origin, then sync, and never root`, () => {
        expect(unixPrefix(loaded)).toBe(
            `env CF_TOKEN=cf-token PLATFORM_URL=https://localhost:6480 INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' SANDBOX_IMAGE='intentic-sandbox:dev' WEB_ORIGIN=https://app.example.dev SYNC_DIR='~/intentic/workspace' `,
        );
        expect(installCommand(loaded)).toBe(bashCommand(`sh`, unixPrefix(loaded), `vphf3wkQ7xK`));
        expect(installCommand(loaded)).not.toContain(`sudo`);
    });

    it(`builds the dev image only from a checkout`, () => {
        expect(unixPrefix({ ...bare, platformUrl: `https://localhost:6480` })).toBe(
            `env PLATFORM_URL=https://localhost:6480 INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' `,
        );
    });
});

describe(`the Windows command`, () => {
    it(`sets platform, origin, token, then sync, and the code last`, () => {
        const input: CommandInput = { ...loaded, os: `windows` };
        expect(windowsEnv(input)).toBe(
            `$env:PLATFORM_URL='https://localhost:6480'; $env:INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'; $env:SANDBOX_IMAGE='intentic-sandbox:dev'; $env:WEB_ORIGIN='https://app.example.dev'; $env:CF_TOKEN='cf-token'; $env:SYNC_DIR='~/intentic/workspace'; $env:SETUP_CODE='vphf3wkQ7xK'; `,
        );
        expect(installCommand(input)).toBe(psCommand(`ps1`, windowsEnv(input)));
    });
});

// The folder and the token are the reader's own, so a quote in either must stay inside its value: one argument to
// `env` in sh, one literal in PowerShell, including the typographic quotes PowerShell also ends a literal at.
describe(`a value holding a quote`, () => {
    const quoted: CommandInput = { ...bare, cfToken: `tok'en`, syncDir: `~/My Work/it's` };

    // The words of a line as sh splits them, for the subset the quoter writes: a space outside quotes ends a word, a
    // single-quoted run is literal, and a backslash outside quotes takes the next character as itself.
    const shWords = (line: string): string[] => {
        const words: string[] = [];
        let word: string | undefined;
        for (let index = 0; index < line.length; index += 1) {
            const char = line[index] ?? ``;
            if (char === ` `) {
                if (word !== undefined) {
                    words.push(word);
                }
                word = undefined;
            } else if (char === `'`) {
                const close = line.indexOf(`'`, index + 1);
                word = (word ?? ``) + line.slice(index + 1, close);
                index = close;
            } else if (char === `\\`) {
                word = (word ?? ``) + (line[index + 1] ?? ``);
                index += 1;
            } else {
                word = (word ?? ``) + char;
            }
        }
        return word === undefined ? words : [...words, word];
    };

    it(`stays one argument to env on unix`, () => {
        expect(unixPrefix(quoted)).toBe(`env CF_TOKEN='tok'\\''en' SYNC_DIR='~/My Work/it'\\''s' `);
        expect(shWords(unixPrefix(quoted))).toEqual([`env`, `CF_TOKEN=tok'en`, `SYNC_DIR=~/My Work/it's`]);
        expect(shWords(installCommand(quoted))).toEqual([
            `curl`,
            `-fsSL`,
            installScriptUrl(`sh`),
            `|`,
            `env`,
            `CF_TOKEN=tok'en`,
            `SYNC_DIR=~/My Work/it's`,
            `sh`,
            `-s`,
            `--`,
            `vphf3wkQ7xK`,
        ]);
    });

    it(`stays one literal on Windows, typographic quotes included`, () => {
        const env = windowsEnv({ ...quoted, os: `windows`, syncDir: `C:\\it's ‘x’` });
        expect(env).toBe(`$env:CF_TOKEN='tok''en'; $env:SYNC_DIR='C:\\it''s ‘‘x’’'; $env:SETUP_CODE='vphf3wkQ7xK'; `);
    });
});

describe(`what the command is built around`, () => {
    it(`offers each shell the remove one-liner, which asks which sandbox`, () => {
        expect(uninstallCommand(`unix`)).toBe(`curl -fsSL https://intentic.dev/remove | sh`);
        expect(uninstallCommand(`windows`)).toBe(`irm https://intentic.dev/remove | iex`);
    });

    it(`rides a platform only when it is this machine's own`, () => {
        expect(platformUrlOf(`https://localhost:6480/rpc`)).toBe(`https://localhost:6480`);
        expect(platformUrlOf(`http://127.0.0.1:6480`)).toBe(`http://127.0.0.1:6480`);
        expect(platformUrlOf(`https://api.intentic.dev`)).toBe(undefined);
    });

    it(`names a page origin only where it is not the default`, () => {
        expect(webOriginOf(`https://app.example.dev`)).toBe(`https://app.example.dev`);
        expect(webOriginOf(PLATFORM_WEB_ORIGIN)).toBe(undefined);
    });
});
