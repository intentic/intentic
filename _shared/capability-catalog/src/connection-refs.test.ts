import { fieldApplies } from "@intentic/extension-manifest";
import { connectionChoices, danglingConnections } from "./connection-refs.js";
import { CAPABILITY_CATALOG, coreFields } from "./index.js";

// A field naming another connection lists the connections it may name, and an add naming none of them is refused: the
// web form and the daemon both read these two.

const connections = [
    { id: "rog", kind: "device", config: { platform: "windows" } },
    { id: "z440", kind: "device", config: { platform: "linux" } },
    { id: "mail", kind: "cli", config: { provider: "imap" } },
    { id: "github", kind: "cli", config: { provider: "github" } },
    { id: "pl", kind: "exit", config: { provider: "tor" } },
];

const fieldOf = (tile: string, key: string) => {
    const field = CAPABILITY_CATALOG.find((entry) => entry.id === tile)?.fields.find((candidate) => candidate.key === key);
    if (field === undefined) {
        throw new Error(`${tile} declares no ${key}`);
    }
    return field;
};

test(`the three free-text names the catalog held are pickers of the connections they name`, () => {
    expect(fieldOf(`netdisk`, `via`).connection).toEqual({ kind: `device` });
    expect(fieldOf(`identity`, `mailbox`).connection).toEqual({ kind: `cli`, provider: `imap` });
    expect(fieldOf(`identity`, `exit`).connection).toEqual({ kind: `exit` });
    expect(coreFields(`browser`).find((field) => field.key === `exit`)?.connection).toEqual({ kind: `exit` });
});

test(`a picker lists every connection of its kind, and only its card's for a kind several cards share`, () => {
    expect(connectionChoices({ kind: `device` }, connections)).toEqual([`rog`, `z440`]);
    expect(connectionChoices({ kind: `cli`, provider: `imap` }, connections)).toEqual([`mail`]);
    expect(connectionChoices({ kind: `exit` }, [])).toEqual([]);
});

test(`an add naming a connection that is not one of those is refused by name, and an empty or gated-out one is not`, () => {
    const fields = CAPABILITY_CATALOG.find((entry) => entry.id === `identity`)?.fields ?? [];
    const applies = (config: Record<string, string>) => (field: Parameters<typeof fieldApplies>[0]) => fieldApplies(field, config);
    const typo = { email: `ann@example.com`, mailbox: `github`, exit: `pl` };

    expect(danglingConnections(fields, typo, connections, applies(typo))).toEqual([
        `"Code mailbox" names "github", which is not a cli (imap) connection here`,
    ]);
    expect(danglingConnections(fields, { email: `ann@example.com`, mailbox: `mail`, exit: `` }, connections, () => true)).toEqual([]);

    const netdisk = CAPABILITY_CATALOG.find((entry) => entry.id === `netdisk`)?.fields ?? [];
    const notSmb = { provider: `nfs`, via: `nowhere` };
    expect(danglingConnections(netdisk, notSmb, connections, applies(notSmb))).toEqual([]);
});
