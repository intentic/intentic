import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { describe, expect, it } from "bun:test";
import { bashCommand, psCommand } from "../../../app/environments/scriptCommand";
import { type CommandInput, installCommand, platformUrlOf, uninstallCommand, unixPrefix, webOriginOf, windowsEnv } from "./installCommand";

// Pins what rides with the setup code, in the order each shell receives it: the own-zone token, the local-dev platform
// (and its image only from a checkout), this page's origin where it is not the default, and the sync folder; root only
// where Docker still has to be installed.

const bare: CommandInput = {
    os: `unix`,
    code: `vphf-3wk`,
    cfToken: undefined,
    platformUrl: undefined,
    fromCheckout: false,
    webOrigin: undefined,
    syncDir: undefined,
    sudo: false,
};
const loaded: CommandInput = {
    ...bare,
    cfToken: `cf-token`,
    platformUrl: `https://localhost:6480`,
    fromCheckout: true,
    webOrigin: `https://app.example.dev`,
    syncDir: `~/intentic/workspace`,
    sudo: true,
};

describe(`the unix command`, () => {
    it(`carries the code alone when nothing else rides with it`, () => {
        expect(unixPrefix(bare)).toBe(``);
        expect(installCommand(bare)).toBe(bashCommand(`sh`, ``, `vphf-3wk`));
    });

    it(`puts root first and every assignment on one env, token, platform, origin, then sync`, () => {
        expect(unixPrefix(loaded)).toBe(
            `sudo env CF_TOKEN='cf-token' PLATFORM_URL='https://localhost:6480' INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' SANDBOX_IMAGE='intentic-sandbox:dev' WEB_ORIGIN='https://app.example.dev' SYNC_DIR='~/intentic/workspace' `,
        );
        expect(installCommand(loaded)).toBe(bashCommand(`sh`, unixPrefix(loaded), `vphf-3wk`));
    });

    it(`builds the dev image only from a checkout`, () => {
        expect(unixPrefix({ ...bare, platformUrl: `https://localhost:6480` })).toBe(
            `env PLATFORM_URL='https://localhost:6480' INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' `,
        );
    });
});

describe(`the Windows command`, () => {
    it(`sets platform, origin, token, then sync, and the code last`, () => {
        const input: CommandInput = { ...loaded, os: `windows` };
        expect(windowsEnv(input)).toBe(
            `$env:PLATFORM_URL='https://localhost:6480'; $env:INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'; $env:SANDBOX_IMAGE='intentic-sandbox:dev'; $env:WEB_ORIGIN='https://app.example.dev'; $env:CF_TOKEN='cf-token'; $env:SYNC_DIR='~/intentic/workspace'; $env:SETUP_CODE='vphf-3wk'; `,
        );
        expect(installCommand(input)).toBe(psCommand(`ps1`, windowsEnv(input)));
    });

    it(`never asks for root, which the unix runner alone needs`, () => {
        expect(windowsEnv({ ...bare, os: `windows`, sudo: true })).toBe(`$env:SETUP_CODE='vphf-3wk'; `);
    });
});

describe(`what the command is built around`, () => {
    it(`offers each shell its own uninstaller`, () => {
        expect(uninstallCommand(`unix`)).toBe(bashCommand(`cleanup`, ``, ``));
        expect(uninstallCommand(`windows`)).toBe(psCommand(`cleanupPs1`, ``));
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
