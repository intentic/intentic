import "@intentic/testing/dom";
import type { OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { effectScope, nextTick } from "vue";
import { useCapacityRail } from "./capacityMemory";
import { activeSandboxId } from "../../../../app/storage/activeSandbox";
import { accountsLoaded, providerAccounts } from "../../../../models/providers/providerAccounts";

// Needs jsdom: whether the rail had figures outlives the page, in localStorage, per sandbox.

const account: OauthAccount = { id: `acc`, label: `first@example.com`, connectedAt: 0 };

let scope = effectScope();

const rail = () => scope.run(() => useCapacityRail())!;

beforeEach(() => {
    localStorage.clear();
    scope = effectScope();
    activeSandboxId.value = `sbx-1`;
    accountsLoaded.value = false;
    providerAccounts.value = {};
});

afterEach(() => scope.stop());

it(`draws no rail on a sandbox never seen with figures while its accounts are read`, () => {
    expect(rail().value).toBe(false);
});

it(`holds the rail open through the read on a sandbox that last had figures`, async () => {
    const shown = rail();
    providerAccounts.value = { claude: [account] };
    accountsLoaded.value = true;
    await nextTick();
    expect(shown.value).toBe(true);

    // The next window on the same sandbox, before its read lands.
    scope.stop();
    scope = effectScope();
    accountsLoaded.value = false;
    providerAccounts.value = {};
    expect(rail().value).toBe(true);

    // Another sandbox has its own memory.
    activeSandboxId.value = `sbx-2`;
    expect(rail().value).toBe(false);
});

it(`forgets the rail once a read finds nothing connected`, async () => {
    providerAccounts.value = { claude: [account] };
    accountsLoaded.value = true;
    const shown = rail();
    await nextTick();

    providerAccounts.value = {};
    await nextTick();
    expect(shown.value).toBe(false);

    accountsLoaded.value = false;
    expect(shown.value).toBe(false);
});
