import type { SandboxNeed, SandboxPasswords } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages, PASSWORDS_EXTENSION_ID } from "./i18n.js";
import { createSandboxPort, manageLink, statusOf } from "./sandboxPort.js";

await registerExtensionMessages(PASSWORDS_EXTENSION_ID, messages);

const SANDBOX = `https://intentic-dev.intentic.dev`;

const read = (over: Partial<SandboxPasswords> = {}): SandboxPasswords => ({
    sandbox: SANDBOX,
    items: [
        {
            name: `GITHUB_COM`,
            title: `github.com`,
            kind: `password`,
            origins: [{ kind: `site`, host: `github.com` }],
            anyField: false,
            machine: `rog`,
            mode: `while-here`,
            online: true,
            updatedAt: 1_000,
            lastUsedAt: 2_000,
        },
        { name: `VPN`, title: `FortiClient`, kind: `password`, origins: [{ kind: `program`, program: `FortiClient.exe` }], anyField: false, machine: `omen`, mode: `copy`, online: false, updatedAt: 500 },
    ],
    keyrings: [
        { machine: `rog`, online: true, setUp: true, locked: false, remember: { browser: true, terminal: false, apps: false, phone: false, sandbox: true } },
        { machine: `omen`, online: false, setUp: false },
    ],
    ...over,
});

const need = (id: string, state: SandboxNeed[`state`]): SandboxNeed => ({ id, origin: { kind: `site`, host: `npmjs.com` }, detail: `publish`, machine: `rog`, state, at: 3_000 });

const portOver = (passwords: SandboxPasswords, needs: readonly SandboxNeed[] = []) => {
    const opened: string[] = [];
    const port = createSandboxPort({
        passwords: async () => passwords,
        needs: async () => ({ needs }),
        activity: async () => ({
            lines: [
                { at: 10, name: `GITHUB_COM`, lane: `shell`, detail: `git push` },
                { at: 11, name: `VPN`, lane: `device`, detail: `rog · FortiClient.exe` },
            ],
        }),
        openLink: (link) => opened.push(link),
    });
    return { port, opened };
};

test(`lists what this sandbox may use, each with its computer and this sandbox's access`, async () => {
    const items = await portOver(read()).port.list();
    expect(items.map((item) => [item.name, item.category, item.computer, item.access[0]?.level])).toEqual([
        [`GITHUB_COM`, `site`, `rog`, `while-here`],
        [`VPN`, `app`, `omen`, `always`],
    ]);
    expect(items[0]?.access[0]?.sandbox).toEqual({ url: SANDBOX, label: `intentic-dev` });
    expect(items[0]?.lastUsedAt).toBe(2_000);
});

test(`is ready while any computer has Passwords set up, and points to the desktop app while none has`, () => {
    expect(statusOf(read().keyrings)).toMatchObject({ kind: `ready`, locked: false, computer: `rog`, remember: { sandbox: true } });
    const none = statusOf([{ machine: `omen`, online: true, setUp: false }]);
    expect(none).toMatchObject({ kind: `not-set-up`, canSetUp: false, computer: `omen` });
    expect(none.kind === `not-set-up` ? none.why : ``).toContain(`desktop app`);
    expect(statusOf([{ machine: `rog`, online: true, setUp: true, locked: true }])).toMatchObject({ kind: `ready`, locked: true });
});

test(`requests are this sandbox's needs still waiting on an answer`, async () => {
    const requests = await portOver(read(), [need(`a`, `pending`), need(`b`, `allowed`)]).port.requests();
    expect(requests).toEqual([
        { id: `a`, sandbox: { url: SANDBOX, label: `intentic-dev` }, origin: { kind: `site`, host: `npmjs.com` }, username: undefined, detail: `publish`, at: 3_000, matches: [], computer: `rog` },
    ]);
});

test(`activity is this sandbox's uses, narrowed to one password when asked`, async () => {
    const { port } = portOver(read());
    expect(await port.activity(`VPN`)).toEqual([{ at: 11, op: `use`, outcome: `ok`, name: `VPN`, target: `rog · FortiClient.exe` }]);
    expect(await port.activity()).toHaveLength(2);
});

test(`manages nothing here, and sends the person to the computer instead`, async () => {
    const { port, opened } = portOver(read());
    expect(port.capabilities).toEqual({ scope: `sandbox`, manage: false, reveal: false });
    await expect(port.reveal(`GITHUB_COM`)).rejects.toThrow(`Manage it in Passwords on your computer.`);
    await expect(port.setAccess(`GITHUB_COM`, SANDBOX, `off`)).rejects.toThrow(`Manage it in Passwords on your computer.`);
    port.manageOnComputer?.(`GITHUB_COM`);
    port.manageOnComputer?.();
    expect(opened).toEqual([`intentic://passwords?entry=GITHUB_COM`, `intentic://passwords`]);
    expect(manageLink(`A B`)).toBe(`intentic://passwords?entry=A%20B`);
});
