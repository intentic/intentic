// Pins the configuration form without mounting it: what a freshly opened tile or connection seeds, which name it
// carries and when that name follows the list, how loudly a box objects and when, what a paste unpacks, the fold,
// the imports that fill it, and what a refused submit shows.
import "@intentic/testing/dom";
import type { CapabilityProbe, CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, contributionEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import { type ForticlientConnection, VAULTED } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { effectScope, type EffectScope, nextTick, ref } from "vue";
import { swallowFileDrag, useCapabilityForm } from "./capabilityForm";
import { seedValues } from "./model/form";

const catalogEntry = (id: string): CapabilityCatalogEntry => CAPABILITY_CATALOG.find((entry) => entry.id === id)!;
const VPN = catalogEntry(`vpn`);
const SSH = catalogEntry(`ssh`);
const EXTENSION = catalogEntry(`extension`);
const PLUGIN = catalogEntry(`plugin`);
const WALLET = catalogEntry(`wallet`);
// A device tile as the devices extension contributes it: the platform pinned, the access switches added.
const LINUX = contributionEntry({
    id: `linux`,
    kind: `device`,
    catalog: { name: `Linux PC`, category: `devices`, description: `Your Linux PC.` },
    fields: [],
    skill: `skills/linux/SKILL.md`,
});
const field = (entry: CapabilityCatalogEntry, key: string, when?: string): CapabilityField =>
    entry.fields.find((candidate) => candidate.key === key && (when === undefined || candidate.when === when))!;

const HEAD = `a1b2c3d4e5f60718293a4b5c6d7e8f9012345678`;
const OLD = `9999999999999999999999999999999999999999`;
const connection = (id: string, kind: CapabilitySummary[`kind`], config: Record<string, string>, secrets: string[] = []): CapabilitySummary => ({
    id,
    kind,
    status: { state: `active` },
    config,
    secrets,
});
const office = connection(`office`, `vpn`, { provider: `fortinet`, server: `vpn.acme.dev`, port: `10443`, realm: `staff`, autoConnect: `on` }, [
    `password`,
]);

interface Opening {
    readonly editing?: CapabilitySummary;
    readonly instances?: readonly CapabilitySummary[];
    readonly device?: string;
    readonly prefill?: Record<string, string>;
}

const scopes: EffectScope[] = [];
beforeEach(() => localStorage.clear());
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

// The form over one tile, as the page hands it over: the URL's tile and connection, the tile's own connections.
const formOn = (entry: CapabilityCatalogEntry, opening: Opening = {}) => {
    const state = {
        selected: ref<CapabilityCatalogEntry | undefined>(entry),
        editing: ref<CapabilitySummary | undefined>(opening.editing),
        instances: ref<readonly CapabilitySummary[]>(opening.instances ?? []),
        capabilities: ref<readonly CapabilitySummary[]>(opening.instances ?? []),
        device: ref(opening.device ?? ``),
        recommendationFor: (tile: string): CapabilityRecommendation | undefined =>
            opening.prefill === undefined ? undefined : { entry: tile, evidence: `.gitlab-ci.yml`, reason: `asked for`, prefill: opening.prefill },
        contributionOf: () => undefined,
        error: ref<NoticeModel | null>(null),
    };
    const scope = effectScope();
    scopes.push(scope);
    return { state, form: scope.run(() => useCapabilityForm(state))! };
};
// Lists a connection as the daemon's next read would, on the tile's own list and the page's.
const listed = (state: ReturnType<typeof formOn>[`state`], instances: readonly CapabilitySummary[]): void => {
    state.instances.value = instances;
    state.capabilities.value = instances;
};

describe(`a freshly opened form`, () => {
    it(`seeds a tile's defaults under a free name, with the fold shut`, () => {
        const { form } = formOn(VPN);

        expect([form.name.value, form.nameEdited.value, form.advancedOpen.value]).toEqual([`vpn`, false, false]);
        expect({ ...form.values }).toEqual(seedValues(VPN, undefined, {}));
        expect([...form.keptSecrets.value]).toEqual([]);
        expect(form.submitLabel.value).toBe(`Add`);
    });

    it(`fills in what the workspace scan read, and a credential this browser remembered`, () => {
        localStorage.setItem(`intentic.devfill.capability.vpn.config`, `[Interface]\nPrivateKey = kept`);
        const { form } = formOn(VPN, { prefill: { provider: `fortinet`, server: `vpn.acme.dev` } });

        expect([form.values[`provider`], form.values[`server`], form.values[`config`]]).toEqual([
            `fortinet`,
            `vpn.acme.dev`,
            `[Interface]\nPrivateKey = kept`,
        ]);
    });

    it(`opens a live connection on its own settings, keeping the credentials it was never shown`, () => {
        const { form } = formOn(VPN, { editing: office, instances: [office] });

        expect([form.name.value, form.values[`server`], form.values[`port`], [...form.keptSecrets.value]]).toEqual([
            `office`,
            `vpn.acme.dev`,
            `10443`,
            [`password`],
        ]);
        // The realm it was saved with is folded away, so the fold opens rather than hide what the edit is set to.
        expect(form.advancedOpen.value).toBe(true);
        expect(form.fieldPlaceholder(field(VPN, `password`, `provider == 'fortinet'`))).toBe(`•••••••••••• already set, leave blank to keep it`);
        expect([form.nameCollision.value, form.submitLabel.value]).toEqual([false, `Save changes`]);
    });

    it(`carries an arriving machine's own name, as chosen`, async () => {
        const { state, form } = formOn(LINUX, { device: `radarsu-rog`, instances: [connection(`linux`, `device`, { platform: `linux` })] });
        expect([form.name.value, form.nameEdited.value]).toEqual([`radarsu-rog`, true]);

        listed(state, [connection(`linux`, `device`, { platform: `linux` }), connection(`linux-2`, `device`, { platform: `linux` })]);
        await nextTick();
        expect(form.name.value).toBe(`radarsu-rog`);
    });
});

describe(`the name`, () => {
    it(`follows the list and whose credential the Test found, until somebody types one`, async () => {
        const { state, form } = formOn(VPN, { instances: [connection(`vpn`, `vpn`, { provider: `wireguard` })] });
        expect(form.name.value).toBe(`vpn-2`);

        listed(state, [...state.instances.value, connection(`vpn-2`, `vpn`, { provider: `wireguard` })]);
        await nextTick();
        expect(form.name.value).toBe(`vpn-3`);

        form.heardWho(VPN, `Ada Lovelace`);
        expect(form.name.value).toBe(`vpn-ada-lovelace`);
        // A later read of the list lands on the same name rather than falling back to a number.
        listed(state, [...state.instances.value]);
        await nextTick();
        expect(form.name.value).toBe(`vpn-ada-lovelace`);

        form.name.value = `home`;
        form.nameEdited.value = true;
        listed(state, [...state.instances.value, connection(`vpn-3`, `vpn`, { provider: `wireguard` })]);
        form.heardWho(VPN, `grace`);
        await nextTick();
        expect(form.name.value).toBe(`home`);
    });

    it(`keeps an edited connection's own name whatever the list or the Test says`, async () => {
        const { state, form } = formOn(VPN, { editing: office, instances: [office] });

        form.heardWho(VPN, `ada`);
        listed(state, [office, connection(`vpn`, `vpn`, { provider: `wireguard` })]);
        await nextTick();
        expect(form.name.value).toBe(`office`);
    });

    it(`shows the repair of a typed name, commits it on leaving the box, and refuses one already taken`, () => {
        const { form } = formOn(VPN, { instances: [office] });

        form.name.value = ` My VPN `;
        expect([form.savedName.value, form.namePreview.value]).toEqual([`My-VPN`, `My-VPN`]);
        form.finishName();
        expect([form.name.value, form.namePreview.value]).toEqual([`My-VPN`, undefined]);

        form.name.value = `office`;
        expect(form.nameCollision.value).toBe(true);
        expect(form.canSubmit.value).toBe(false);
        form.name.value = `  `;
        expect(form.nameProblem.value).toBe(`Name is required.`);
    });
});

describe(`a box's objections`, () => {
    it(`stay silent until the box is left, then name a malformed value in red and an empty one quietly`, () => {
        const { form } = formOn(EXTENSION);
        const url = field(EXTENSION, `url`);
        const pin = field(EXTENSION, `ref`);

        form.values[`url`] = `not a url`;
        expect([form.fieldAlarm(url), form.fieldQuiet(pin)]).toEqual([undefined, false]);
        form.finishField(url);
        form.finishField(pin);
        expect([form.fieldAlarm(url), form.fieldAlarm(pin), form.fieldQuiet(pin)]).toEqual([`Enter a valid URL (e.g. https://…).`, undefined, true]);
    });

    it(`repairs a value on leaving the box, where the reader sees it`, () => {
        const { form } = formOn(EXTENSION);
        const url = field(EXTENSION, `url`);

        form.values[`url`] = ` github.com/acme/ext `;
        form.finishField(url);
        expect([form.values[`url`], form.fieldChecked(url), form.fieldAlarm(url)]).toEqual([`https://github.com/acme/ext`, true, undefined]);
    });

    it(`turns a refused submit into red on every empty required box, and shakes once the DOM has caught up`, async () => {
        const { form } = formOn(SSH);
        form.touchAll();
        expect(form.fieldQuiet(field(SSH, `host`))).toBe(true);

        form.refuse(SSH);
        expect([form.attempted.value, form.shaking.value, form.fieldAlarm(field(SSH, `host`)), form.fieldQuiet(field(SSH, `host`))]).toEqual([
            true,
            false,
            `This field is required.`,
            false,
        ]);
        await nextTick();
        expect(form.shaking.value).toBe(true);
    });

    it(`opens the fold when what refused the submit sits inside it`, () => {
        const { form } = formOn(VPN);
        form.values[`provider`] = `ipsec`;
        form.refuse(VPN);
        expect(form.advancedOpen.value).toBe(false);

        form.values[`dhGroup`] = ``;
        form.refuse(VPN);
        expect(form.advancedOpen.value).toBe(true);
    });
});

describe(`what a box can do for the reader`, () => {
    it(`unpacks a paste holding several answers and notes where they went, until the box is edited by hand`, () => {
        const { form } = formOn(SSH);
        const host = field(SSH, `host`);
        const paste = (text: string) => {
            const preventDefault = mock();
            return { event: { clipboardData: { getData: () => text }, preventDefault } as unknown as ClipboardEvent, preventDefault };
        };

        const command = paste(`ssh -p 2222 root@box.acme.dev`);
        form.onFieldPaste(host, command.event);
        expect(command.preventDefault).toHaveBeenCalledTimes(1);
        expect([form.values[`host`], form.values[`port`], form.values[`user`]]).toEqual([`box.acme.dev`, `2222`, `root`]);
        expect(form.pasteNotes[`host`]).toBe(`Read from the paste: host box.acme.dev · port 2222 · user root.`);

        form.onFieldInput(host);
        expect(form.pasteNotes[`host`]).toBeUndefined();
        // A bare hostname is an ordinary paste: the browser puts it in the box.
        const plain = paste(`box.acme.dev`);
        form.onFieldPaste(host, plain.event);
        expect(plain.preventDefault).toHaveBeenCalledTimes(0);
        expect(form.pasteNotes[`host`]).toBeUndefined();
    });

    it(`offers the container-reachable address for a localhost URL, and reads a WireGuard config back`, () => {
        const extension = formOn(EXTENSION).form;
        const url = field(EXTENSION, `url`);
        extension.values[`url`] = `http://localhost:3000/ext.git`;
        expect(extension.fieldUrlFix(url)).toBe(`http://host.docker.internal:3000/ext.git`);
        extension.applyUrlFix(url);
        expect([extension.values[`url`], extension.fieldUrlFix(url)]).toEqual([`http://host.docker.internal:3000/ext.git`, undefined]);

        const vpn = formOn(VPN).form;
        vpn.values[`config`] = `[Interface]\nPrivateKey = x\n[Peer]\nEndpoint = 1.2.3.4:51820`;
        expect(vpn.fieldConfSummary(field(VPN, `config`))).toEqual({ text: `Read: 1 config · endpoint 1.2.3.4:51820.`, warning: false });
        expect(vpn.fieldConfSummary(field(VPN, `autoConnect`))).toBeUndefined();
    });
});

describe(`the fold and what the answers add up to`, () => {
    it(`splits a tile's questions from what nearly everyone leaves at its default`, () => {
        const { form } = formOn(WALLET);

        expect(form.mainFields(WALLET).map((shown) => shown.key)).toEqual([`network`, `perPaymentMaxUsd`, `dailyCapUsd`, `autoApproveUnderUsd`]);
        expect(form.advancedFields(WALLET).map((shown) => shown.key)).toEqual([`allow`, `deny`]);
        expect(form.formSummary.value).toBe(`Every payment asks you in chat first · at most $1.00 each · $5.00 a day.`);
        expect(form.liveEffects.value).toEqual([
            { kind: `spend`, perPaymentUsd: `1.00`, dailyUsd: `5.00`, carded: true },
            { kind: `skill`, name: `wallet` },
        ]);
    });

    it(`reads an edited private install's versions with the marker for the token it keeps`, () => {
        const ext = connection(`ext`, `extension`, { url: `https://github.com/acme/ext`, ref: OLD }, [`token`]);
        const { form } = formOn(EXTENSION, { editing: ext, instances: [ext] });
        expect(form.versionToken.value).toBe(VAULTED);

        form.values[`token`] = `ghp_new`;
        expect(form.versionToken.value).toBe(`ghp_new`);
    });

    it(`offers the agent's read once a commit is pinned, of what changed when an edit moves the pin`, () => {
        const ext = connection(`ext`, `extension`, { url: `https://github.com/acme/ext`, ref: OLD });
        const { form } = formOn(EXTENSION, { editing: ext, instances: [ext] });
        expect([form.auditable.value, form.updateFrom.value]).toEqual([true, undefined]);

        form.values[`ref`] = HEAD;
        expect([form.auditable.value, form.updateFrom.value]).toEqual([true, OLD]);
        form.values[`ref`] = `main`;
        expect([form.auditable.value, form.updateFrom.value]).toEqual([false, undefined]);
    });
});

describe(`what fills the form from elsewhere`, () => {
    it(`sets every access switch from a posture, and ignores one it does not know`, () => {
        const { form } = formOn(LINUX);
        expect(form.hostPresetOptions.map((option) => option.value)).toEqual([`observe`, `operate`, `full`]);

        form.applyHostPreset(`full`);
        const switches = () => [`shell`, `write`, `screen`, `control`, `sandboxes`, `destructive`].map((key) => form.values[key]);
        expect(switches()).toEqual([`on`, `on`, `on`, `on`, `on`, `off`]);
        form.applyHostPreset(`everything`);
        expect(switches()).toEqual([`on`, `on`, `on`, `on`, `on`, `off`]);
    });

    it(`takes a registry pick whole, name included`, () => {
        const { form } = formOn(PLUGIN);

        form.applyRegistryPick({ name: `review-tools`, url: `https://github.com/acme/plugins`, ref: HEAD, path: `review`, token: `` });
        expect([form.name.value, form.nameEdited.value, form.values[`url`], form.values[`ref`], form.values[`path`], form.values[`token`]]).toEqual([
            `review-tools`,
            true,
            `https://github.com/acme/plugins`,
            HEAD,
            `review`,
            ``,
        ]);
    });

    it(`imports a FortiClient connection without the credentials an edit was keeping, landing on what still needs typing`, () => {
        const { form } = formOn(VPN, { editing: office, instances: [office] });
        const server = field(VPN, `server`, `provider == 'fortinet'`);
        form.finishField(server);
        const imported: ForticlientConnection = {
            id: `warszawa`,
            label: `ZTM Warszawa`,
            provider: `fortinet`,
            server: `91.234.246.82`,
            port: 10_443,
            needs: [`username`, `password`],
        };

        form.pickForticlient(imported);
        expect([form.name.value, form.nameEdited.value, [...form.keptSecrets.value]]).toEqual([`warszawa`, true, []]);
        expect([form.values[`server`], form.values[`port`], form.values[`username`], form.values[`password`]]).toEqual([
            `91.234.246.82`,
            `10443`,
            ``,
            ``,
        ]);
        expect(form.fieldQuiet(field(VPN, `username`, `provider == 'fortinet'`))).toBe(false);
    });
});

describe(`a fresh form`, () => {
    it(`is seeded again, clean, when the URL opens another tile, and not when the list merely re-reads`, async () => {
        const { state, form } = formOn(VPN);
        form.values[`server`] = `typed`;
        form.finishField(field(VPN, `server`, `provider == 'fortinet'`));
        form.refuse(VPN);
        form.pasteNotes[`server`] = `Read from the paste: host typed.`;
        form.probeResult.value = { checked: true, ok: true, message: `Signed in as ada.` } satisfies CapabilityProbe;
        state.error.value = { tone: `danger`, title: `Could not add the capability.` };

        state.selected.value = { ...VPN };
        await nextTick();
        expect(form.values[`server`]).toBe(`typed`);

        state.selected.value = SSH;
        await nextTick();
        expect([form.name.value, form.attempted.value, form.shaking.value]).toEqual([`ssh`, false, false]);
        expect({ ...form.pasteNotes }).toEqual({});
        expect(form.probeResult.value).toBeUndefined();
        expect(state.error.value).toBeNull();
        expect({ ...form.values }).toEqual(seedValues(SSH, undefined, {}));
        expect(form.fieldQuiet(field(SSH, `host`))).toBe(false);
    });

    it(`starts over on the next free name once a pending add left it up`, () => {
        const { state, form } = formOn(VPN);
        form.values[`server`] = `typed`;
        listed(state, [connection(`vpn`, `vpn`, { provider: `wireguard` })]);

        form.startOver(VPN);
        expect([form.name.value, form.nameEdited.value, { ...form.values }]).toEqual([`vpn-2`, false, {}]);
    });
});

describe(`a file dragged over the page`, () => {
    it(`is swallowed, so a drop outside the import zone cannot navigate away from a half-filled form`, () => {
        const drag = (types: string[]) => {
            const preventDefault = mock();
            swallowFileDrag({ dataTransfer: { types }, preventDefault } as unknown as DragEvent);
            return preventDefault;
        };

        expect(drag([`Files`])).toHaveBeenCalledTimes(1);
        expect(drag([`text/plain`])).toHaveBeenCalledTimes(0);
    });
});
