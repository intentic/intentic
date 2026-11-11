import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AddCapabilityInput, type CapabilityCatalogEntry, contributionEntry } from "@intentic/capability-catalog";
import { repoRoot } from "@intentic/constants/node";
import { CapabilityContributionSchema } from "@intentic/extension-manifest";
import { stashedMarker } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DeviceSignInStart, DeviceSignInWait } from "@intentic/sandbox-contract/schemas/device-sign-in";
import { standInOf } from "../fieldStandIn";
import { grantedLine, signsInWithMicrosoft, useDeviceSignIn } from "./microsoftSignIn";

// The first-party cards as the daemon serves them to the catalog: their manifests, parsed by the manifest's own schema.
const tileOf = (dir: string): CapabilityCatalogEntry => {
    // SAFETY: a first-party manifest; the schema parse below is what checks the card.
    const raw = JSON.parse(readFileSync(join(repoRoot(import.meta.url), `_extensions`, dir, `intentic-extension.json`), `utf8`)) as {
        contributes: { capabilities: unknown[] };
    };
    return contributionEntry(CapabilityContributionSchema.parse(raw.contributes.capabilities[0]));
};
const fieldOf = (tile: CapabilityCatalogEntry, key: string) => tile.fields.find((field) => field.key === key)!;

test(`the Microsoft 365 card signs in on its form, unless its app brings a secret and its own token`, () => {
    const m365 = tileOf(`microsoft-365`);
    const token = fieldOf(m365, `refreshToken`);

    expect(standInOf(m365, token, { tenantId: `t`, clientId: `c`, access: `read` })).toBe(`microsoftSignIn`);
    expect(signsInWithMicrosoft(m365, token, { clientSecret: `app-secret` })).toBe(false);
    expect(m365.fields.filter((field) => signsInWithMicrosoft(m365, field, {})).map((field) => field.key)).toEqual([`refreshToken`]);
});

// The Google branch of the same field stays the box it was: a pasted Gmail token is not Microsoft's to fill.
test(`the IMAP card signs in with Microsoft for Exchange Online only`, () => {
    const imap = tileOf(`imap`);
    const token = fieldOf(imap, `oauthRefreshToken`);
    const oauth = { authMode: `oauth2`, oauthTenant: `t`, oauthClientId: `c` };

    expect(standInOf(imap, token, { ...oauth, oauthProvider: `microsoft` })).toBe(`microsoftSignIn`);
    expect(standInOf(imap, token, { ...oauth, oauthProvider: `google` })).toBeUndefined();
    expect(standInOf(imap, token, { ...oauth, oauthProvider: `microsoft`, oauthClientSecret: `s` })).toBeUndefined();
    expect(standInOf(imap, fieldOf(imap, `password`), { authMode: `password` })).toBeUndefined();
});

const INPUT: AddCapabilityInput = { id: `office`, kind: `cli`, config: { provider: `microsoft365`, tenantId: `t`, clientId: `c` } };
const STARTED: DeviceSignInStart = { flow: `flow-1`, userCode: `L2ACH3MRV`, verificationUri: `https://login.microsoft.com/device`, expiresIn: 900 };

// A wait the test answers by hand, so the form can be looked at while the sandbox is still asking Microsoft.
const heldWaits = () => {
    const pending: ((answer: DeviceSignInWait) => void)[] = [];
    const asked: string[] = [];
    const wait = (flow: string): Promise<DeviceSignInWait> => {
        asked.push(flow);
        return new Promise((resolve) => pending.push(resolve));
    };
    const answer = async (said: DeviceSignInWait): Promise<void> => {
        pending.shift()?.(said);
        await Promise.resolve();
        await Promise.resolve();
    };
    return { wait, answer, asked };
};

test(`shows the code with Microsoft's page while it waits, and hands the form a marker once someone signed in`, async () => {
    const waits = heldWaits();
    const started: AddCapabilityInput[] = [];
    const { phase, problem, begin } = useDeviceSignIn({
        start: async (input) => {
            started.push(input);
            return STARTED;
        },
        wait: waits.wait,
    });

    const signedIn = begin(INPUT);
    await Promise.resolve();
    await Promise.resolve();
    expect(phase.value).toEqual({ kind: `waiting`, code: `L2ACH3MRV`, page: `https://login.microsoft.com/device` });
    await waits.answer({ state: `waiting` });
    await waits.answer({ state: `done`, token: `tok`, who: `ada@contoso.example`, granted: [`Mail.Read`, `User.Read`], bound: [`tenantId`] });

    expect(await signedIn).toEqual({ marker: stashedMarker(`tok`), who: `ada@contoso.example`, granted: [`Mail.Read`, `User.Read`], bound: [`tenantId`] });
    expect(started).toEqual([INPUT]);
    expect(waits.asked).toEqual([`flow-1`, `flow-1`]);
    expect(phase.value).toEqual({ kind: `idle` });
    expect(problem.value).toBeUndefined();
});

test(`says why a sign-in did not start or did not finish, in the sandbox's words`, async () => {
    const refusing = useDeviceSignIn({
        start: () => Promise.reject(new Error(`Fill in Directory (tenant) ID first.`)),
        wait: () => Promise.reject(new Error(`never asked`)),
    });
    expect(await refusing.begin(INPUT)).toBeUndefined();
    expect(refusing.problem.value).toBe(`Fill in Directory (tenant) ID first.`);
    expect(refusing.phase.value).toEqual({ kind: `idle` });

    const declined = useDeviceSignIn({
        start: async () => STARTED,
        wait: async () => ({ state: `failed`, message: `The sign-in was declined on Microsoft's page.` }),
    });
    expect(await declined.begin(INPUT)).toBeUndefined();
    expect(declined.problem.value).toBe(`The sign-in was declined on Microsoft's page.`);
});

test(`a sign-in the person stopped waiting for is let go, and its late answer changes nothing`, async () => {
    const waits = heldWaits();
    const { phase, begin, cancel } = useDeviceSignIn({ start: async () => STARTED, wait: waits.wait });

    const signedIn = begin(INPUT);
    await Promise.resolve();
    await Promise.resolve();
    cancel();
    await waits.answer({ state: `done`, token: `late`, granted: [], bound: [] });

    expect(await signedIn).toBeUndefined();
    expect(phase.value).toEqual({ kind: `idle` });
    expect(waits.asked).toEqual([`flow-1`]);
});

test(`names what was granted, by each permission's short name`, () => {
    expect(grantedLine([`Mail.Read`, `Calendars.Read`])).toBe(`Granted Mail.Read, Calendars.Read. Saving the card stores the sign-in.`);
    expect(grantedLine([])).toBe(`Saving the card stores the sign-in.`);
});
