import "@intentic/testing/dom";
import type { SandboxSummary, SetupCode } from "@intentic/api-contract";
import { syncFolder } from "@intentic/sandbox-contract";
import { type EffectScope, effectScope, ref } from "vue";
import { desktopSetupLink } from "../../../app/environments/desktop";
import type { desktopInstaller } from "../../../app/environments/desktopDownloads";
import { bashCommand } from "../../../app/environments/scriptCommand";
import { sandboxSummary } from "../../../testing/sandboxSummary";
import { useRunStep } from "./useRunStep";

// Pins step 2 on the reader's own machine: the compose tab never overwrites the shell preference, the command folds
// behind the app, the phone and an offered installer until asked for, sync is offered only beside a command it can
// ride, and the app is handed exactly the code, row and options the command would carry.

const minted: SetupCode = { code: `vphf-3wk`, hostname: `sandbox-fa0b431303b8.sbx.intentic.dev`, expiresAt: `2026-09-23T10:10:00Z` };
const windows = { platform: `windows`, label: `Windows`, href: `https://intentic.dev/download/windows` } as const;
const scopes: EffectScope[] = [];

const stage = (over: { mobile?: boolean; inApp?: boolean; installer?: ReturnType<typeof desktopInstaller> } = {}) => {
    const command = { setup: ref<SetupCode | null>(null), commandReady: ref(false), launched: ref(false) };
    const row = { created: ref<SandboxSummary | null>(sandboxSummary({ id: `s1`, name: `workspace` })) };
    const reader = { mobile: ref(over.mobile ?? false), inApp: ref(over.inApp ?? false), installer: ref(over.installer) };
    const cmdOs = ref<`unix` | `windows`>(`unix`);
    const mode = ref<`intentic` | `own`>(`intentic`);
    const cfToken = ref(``);
    const openDesktopLink = jest.fn((_link: string) => undefined);
    const scope = effectScope();
    scopes.push(scope);
    const step = scope.run(() => useRunStep({ command, row, reader, cmdOs, mode, cfToken, openDesktopLink }))!;
    const ready = (): void => {
        command.setup.value = minted;
        command.commandReady.value = true;
    };
    return { command, row, cmdOs, mode, cfToken, openDesktopLink, step, ready };
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

describe(`which command is on screen`, () => {
    it(`keeps the shell preference when the compose tab is picked, and moves it for a shell`, () => {
        const { cmdOs, step } = stage();
        step.runTab.value = `compose`;
        expect({ tab: step.runTab.value, os: cmdOs.value }).toEqual({ tab: `compose`, os: `unix` });
        step.runTab.value = `windows`;
        expect({ tab: step.runTab.value, os: cmdOs.value }).toEqual({ tab: `windows`, os: `windows` });
    });

    it(`sheds the tabs' qualifiers on a phone`, () => {
        expect(stage({ mobile: true }).step.runTabOptions.value.map((option) => option.label)).toEqual([`Linux / macOS`, `Windows`, `Compose`]);
        expect(stage().step.runTabOptions.value.map((option) => option.label)).toEqual([`Linux / macOS`, `Windows (PowerShell)`, `Docker Compose`]);
    });

    it.each<[string, Parameters<typeof stage>[0]]>([
        [`inside the app`, { inApp: true }],
        [`on a phone`, { mobile: true }],
        [`where an installer is offered`, { installer: windows }],
    ])(`folds the command away %s until the reader asks for it`, (_, over) => {
        const { step } = stage(over);
        expect(step.commandVisible.value).toBe(false);
        step.showCommand.value = true;
        expect(step.commandVisible.value).toBe(true);
    });

    it(`retries a failed run by the app's button wherever no command is on screen`, () => {
        const offered = stage({ installer: windows });
        expect({ installing: offered.step.installing.value, retried: offered.step.retriedByButton.value }).toEqual({
            installing: true,
            retried: true,
        });
        expect(stage({ mobile: true }).step.retriedByButton.value).toBe(false);
        expect(stage({ inApp: true }).step.retriedByButton.value).toBe(true);
    });
});

describe(`what rides with the command`, () => {
    it(`is nothing but an empty line before a code exists`, () => {
        expect(stage().step.selectedCommand.value).toBe(``);
    });

    it(`carries the sync folder while sync is on, and the token only on the own-zone path`, () => {
        const { mode, cfToken, step, ready } = stage();
        ready();
        const folder = syncFolder(`workspace`, minted.hostname);
        const dev = ` PLATFORM_URL='http://localhost' INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' SANDBOX_IMAGE='intentic-sandbox:dev'`;
        const origin = step.webOrigin === undefined ? `` : ` WEB_ORIGIN='${step.webOrigin}'`;
        expect(step.selectedCommand.value).toBe(bashCommand(`sh`, `env${dev}${origin} SYNC_DIR='${folder}' `, minted.code));
        mode.value = `own`;
        cfToken.value = ` cf-token `;
        step.syncEnabled.value = false;
        expect(step.selectedCommand.value).toBe(bashCommand(`sh`, `env CF_TOKEN='cf-token'${dev}${origin} `, minted.code));
    });

    it(`offers sync only beside a command it can ride, and never on the compose tab`, () => {
        const { step, ready } = stage();
        expect(step.syncOffered.value).toBe(false);
        ready();
        expect(step.syncOffered.value).toBe(true);
        step.runTab.value = `compose`;
        expect(step.syncOffered.value).toBe(false);
    });

    it(`hands compose the published image and this page's origin`, () => {
        const { step, ready } = stage();
        ready();
        expect(step.composeArgs.value).toEqual({
            code: minted.code,
            hostname: minted.hostname,
            image: `ghcr.io/intentic/sandbox:stable`,
            googleClientId: ``,
            webOrigin: globalThis.location.origin,
            platformUrl: `http://localhost`,
        });
    });
});

describe(`the handoff to the app`, () => {
    it(`hands over the code, the row and what the command would carry, and marks the code as launched`, () => {
        const { command, openDesktopLink, step, ready } = stage({ inApp: true });
        ready();
        step.runHere();
        expect(command.launched.value).toBe(true);
        expect(openDesktopLink.mock.calls).toEqual([
            [
                desktopSetupLink({
                    code: minted.code,
                    sandboxId: `s1`,
                    name: `workspace`,
                    syncDir: syncFolder(`workspace`, minted.hostname),
                    platformUrl: `http://localhost`,
                }),
            ],
        ]);
    });

    it(`hands over nothing before there is a code and a row`, () => {
        const { row, command, openDesktopLink, step, ready } = stage({ inApp: true });
        step.runHere();
        ready();
        row.created.value = null;
        step.runHere();
        expect(openDesktopLink).not.toHaveBeenCalled();
        expect(command.launched.value).toBe(false);
    });
});
