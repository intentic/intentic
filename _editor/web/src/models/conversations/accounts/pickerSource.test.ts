import { resetSandboxScope } from "@intentic/extension-api";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { setDaemonRoutes } from "../../../client/sandbox/useDaemonRoutes";
import { noteHarnessAccountsRead } from "../../providers/computer/computerHarnesses";
import { advertisedLoops } from "../../providers/offeredLoops";
import { providerAccounts } from "../../providers/providerAccounts";
import { acpProviders, nativeReady, perProvider, providerModels } from "../../providers/providerCatalog";
import { pickerSource } from "./pickerSource";

// The one model picker asks the same questions of its providers on either side of the app (pickerSource.ts). In a folder
// window where this computer runs agents the answers are the coding agents installed here, judged from what the sidecar
// lists, and never a sandbox's vendors, prices or catalogue.

const account = (extra: Partial<OauthAccount> = {}): OauthAccount => ({ id: `this-computer`, label: `Claude Max`, connectedAt: 1, ...extra });

// A computer with Claude Code installed and signed in, OpenCode installed (its sign-in its own), and Codex not set up.
const thisComputer = (): void => {
    setDaemonRoutes([`agent.run`, `agents.list`, `providers.list`], undefined, `folder`);
    advertisedLoops.value = { claude: [`native`], codex: [`native`], opencode: [`native`] };
    nativeReady.value = [`claude`];
    acpProviders.value = [{ id: `opencode`, label: `OpenCode` }];
    providerAccounts.value = { ...perProvider(() => []), claude: [account()] };
    noteHarnessAccountsRead(`claude`);
    providerModels.value = {
        ...perProvider(() => []),
        claude: [
            { label: `Default (recommended)`, value: `default`, description: `Opus` },
            { label: `Sonnet 5.5`, value: `sonnet` },
        ],
    };
};

beforeEach(() => resetSandboxScope());

describe(`the model picker's source in a folder window where this computer runs agents`, () => {
    beforeEach(thisComputer);

    it(`offers the coding agents of this computer, in lanes named as the programs name themselves`, () => {
        const source = pickerSource.value;
        expect(source.kind).toBe(`computer`);
        const offered = source.offered(`claude`);
        expect(offered).toEqual([`claude`, `opencode`, `codex`]);
        expect(source.lanes(offered).map((lane) => lane.label)).toEqual([`Claude Code`, `OpenCode`, `Codex`]);
    });

    it(`lists the models of the ones that run, each as the harness names it, and one row for an agent that keeps its own`, () => {
        expect(pickerSource.value.entries().map((entry) => [entry.provider, entry.value, entry.label])).toEqual([
            [`claude`, `default`, `Default (recommended)`],
            [`claude`, `sonnet`, `Sonnet 5.5`],
            [`opencode`, ``, `OpenCode`],
        ]);
    });

    it(`locks an agent not set up, says what it needs on its chip, and dates no harness alias as older`, () => {
        const source = pickerSource.value;
        expect([source.runnable(`claude`), source.locked(`claude`), source.chip(`claude`)]).toEqual([true, false, undefined]);
        expect([source.runnable(`codex`), source.locked(`codex`), source.chip(`codex`)]).toEqual([false, true, `Not set up`]);
        expect(source.older({ key: `claude:sonnet`, provider: `claude`, value: `sonnet`, label: `Sonnet 5.5` })).toBe(false);
    });

    it(`calls a signed-out agent that, and says nothing can run only once none can`, () => {
        expect(pickerSource.value.nothingRunnable()).toBe(false);
        providerAccounts.value = perProvider(() => []);
        acpProviders.value = [];
        expect(pickerSource.value.chip(`claude`)).toBe(`Signed out`);
        expect(pickerSource.value.nothingRunnable()).toBe(true);
        expect(pickerSource.value.nothingShared()).toBe(false);
    });

    // A conversation stays on its own pick's lane even where the listing dropped that program, so its tick has a row.
    it(`keeps the conversation's own agent on offer though the listing no longer names it`, () => {
        expect(pickerSource.value.offered(`gemini`)).toEqual([`gemini`, `claude`, `opencode`, `codex`]);
    });
});

describe(`the model picker's source in a sandbox`, () => {
    it(`is the sandbox's vendors, as it always was`, () => {
        setDaemonRoutes([`agent.run`, `agents.list`]);
        expect(pickerSource.value.kind).toBe(`sandbox`);
    });
});
