import { join } from "node:path";
import { type JsonValue, parseJsonOr } from "@intentic/base/json";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import { REACHABLE_CREDENTIAL_KINDS } from "@intentic/sandbox-contract/schemas/members";
import { CEILING_SWITCHES, type ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { z } from "zod";
import { accessProfilesDocument } from "../auth/principals/access-profiles-store.js";
import { areasDocument } from "../areas/areas-store.js";
import { stateRelPath } from "../state-paths.js";
import { defineStep } from "../store/evolution/state-steps.js";
import { rolesDocument } from "./roles-store.js";

// A ROLE CARD'S OWN LIMITS, MOVED INTO ACCESS (2026-11-18, docs/architecture/access.md). A card used to carry its
// shelves (`powers`), its connector, device, server and extension lists, and the folders its file tools may touch
// (`workspace.folders`), each a narrowing a person could lift for one conversation from a card. Those are access now: an
// access profile on the history volume lists the card in `roles`, and a conversation wearing it is held to that profile
// like it is to the people it acts for. This step writes, for each card that limited anything:
//   - a profile `role-<id>` carrying the same limits: its shelves as the tool ceiling, its lists as the connected
//     capabilities it may spend, its folders as an area;
//   - that area, `role-<id>`, unless an area already names exactly those folders;
//   - the card without `powers` and `workspace.folders`, and with the single folder it was fenced to as the place it
//     opens when it named none (role-home.ts reads a card's home from there alone now).
// What a profile cannot say is said in the plan: a list meant "these, and nothing of this kind connected later", which a
// profile keeps as the connections standing today; a card limited no secret, so its profile lists every secret stored
// today. One-shot by construction: a card with neither field left has nothing to move.

// Two files the step reads and never writes, by address rather than through their stores, which belong to domains a
// role's store must not reach into: the connections (capabilities-store.ts) and the stored secrets' names
// (secrets/sandbox-secrets.ts, on the auth root).
const CAPABILITIES = stateRelPath(".intentic/config/capabilities.json");
const SANDBOX_SECRETS = "sandbox-secrets.json";

// The card as it was stored, raw: the schema no longer knows the two fields this step moves. Everything else on it is
// kept as written.
const LegacyPowersSchema = z
    .object({
        files: z.enum(["none", "read", "write"]).optional(),
        shell: z.boolean().optional(),
        code: z.boolean().optional(),
        web: z.boolean().optional(),
        browser: z.boolean().optional(),
        delegate: z.boolean().optional(),
        sandbox: z.boolean().optional(),
        connectors: z.array(z.string()).optional(),
        devices: z.array(z.string()).optional(),
        mcp: z.array(z.string()).optional(),
        extensions: z.array(z.string()).optional(),
    })
    .passthrough();
type LegacyPowers = z.infer<typeof LegacyPowersSchema>;

const LegacyCardSchema = z
    .object({
        id: z.string(),
        label: z.string().optional(),
        powers: LegacyPowersSchema.optional(),
        workspace: z.object({ startIn: z.string().optional(), folders: z.array(z.string()).optional() }).passthrough().optional(),
    })
    .passthrough();
type LegacyCard = z.infer<typeof LegacyCardSchema>;

const Identified = z.object({ id: z.string() }).passthrough();
const StoredArea = z.object({ id: z.string(), folders: z.array(z.string()) }).passthrough();
type StoredArea = z.infer<typeof StoredArea>;
const StoredCapability = z.object({ id: z.string(), kind: z.string() }).passthrough();
type StoredCapability = z.infer<typeof StoredCapability>;

// A list file as stored: every entry as written, and the ones this step can read.
interface ListFile<T> {
    readonly raw: JsonValue[];
    readonly read: T[];
}

const JsonEntries = z.array(z.custom<JsonValue>(() => true));

// Each entry of a list file this step can read; the rest are kept as they are and never looked into.
const entriesOf = <S extends z.ZodTypeAny>(text: string | undefined, schema: S): ListFile<z.infer<S>> => {
    const parsed = JsonEntries.safeParse(text === undefined ? undefined : parseJsonOr(text, undefined));
    const raw = parsed.success ? parsed.data : [];
    return { raw, read: raw.flatMap((entry) => (schema.safeParse(entry).success ? [schema.parse(entry)] : [])) };
};

const canonical = (entries: readonly (JsonValue | KeptCard | AccessProfile | NewArea)[]): string => `${JSON.stringify(entries, undefined, 2)}\n`;

// Whether a card still carries a field this step moves: the one test of whether it has anything left to do.
const carries = (card: LegacyCard): boolean => card.powers !== undefined || card.workspace?.folders !== undefined;

// The tool ceiling a card's shelves come to: each one it switched off, files below write, and its extension list.
// Undefined when it switched nothing off.
const ceilingOf = (powers: LegacyPowers | undefined): ToolCeiling | undefined => {
    if (powers === undefined) {
        return undefined;
    }
    const ceiling: ToolCeiling = {};
    if (powers.files === "read" || powers.files === "none") {
        ceiling.files = powers.files;
    }
    for (const shelf of CEILING_SWITCHES) {
        if (powers[shelf] === false) {
            ceiling[shelf] = false;
        }
    }
    if (powers.extensions !== undefined) {
        ceiling.extensions = powers.extensions;
    }
    return Object.keys(ceiling).length === 0 ? undefined : ceiling;
};

// The list a card kept for a capability of this kind, or undefined where it kept none (every one of the kind). A linked
// sandbox sat on the devices list beside the owner's computers.
const listFor = (powers: LegacyPowers, kind: string): readonly string[] | undefined => {
    if (kind === "cli") {
        return powers.connectors;
    }
    if (kind === "device" || kind === "phone" || kind === "link") {
        return powers.devices;
    }
    return kind === "mcp" ? powers.mcp : undefined;
};

interface Credentials {
    readonly capabilities: string[];
    readonly secrets: string[];
}

// The credentials a card's lists come to, over what is connected and stored today; undefined when it kept no list.
// Signed-in accounts pass: which of those a card speaks through stays on the card.
const credentialsOf = (powers: LegacyPowers | undefined, connected: readonly StoredCapability[], secrets: readonly string[]): Credentials | undefined => {
    if (powers?.connectors === undefined && powers?.devices === undefined && powers?.mcp === undefined) {
        return undefined;
    }
    const capabilities = connected
        .filter((capability) => REACHABLE_CREDENTIAL_KINDS.some((kind) => kind === capability.kind))
        .filter((capability) => {
            const list = listFor(powers, capability.kind);
            return list === undefined || list.includes(capability.id);
        })
        .map((capability) => capability.id);
    return { capabilities, secrets: [...secrets] };
};

const sameFolders = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((folder) => right.includes(folder));

const freeId = (wanted: string, taken: Set<string>): string => {
    let id = wanted;
    for (let n = 2; taken.has(id); n += 1) {
        id = `${wanted}-${n}`;
    }
    taken.add(id);
    return id;
};

// The card as it is kept from now on: neither moved field, and the one folder it was fenced to as where it opens.
type KeptCard = Omit<LegacyCard, "powers" | "workspace"> & { workspace?: { startIn: string } };

const withoutMoved = (card: LegacyCard): KeptCard => {
    const { powers: _powers, workspace, ...rest } = card;
    const named = workspace?.startIn;
    const folders = workspace?.folders;
    const startIn = named !== undefined && named !== "" ? named : folders?.length === 1 ? folders[0] : undefined;
    return startIn === undefined ? rest : { ...rest, workspace: { startIn } };
};

interface NewArea {
    readonly id: string;
    readonly label: string;
    readonly folders: string[];
}

// What the step adds beside the cards as it goes: the profiles and areas files, and the ids taken in each.
interface Beside {
    readonly profiles: (JsonValue | AccessProfile)[];
    readonly areas: (JsonValue | NewArea)[];
    readonly standingAreas: readonly StoredArea[];
    readonly profileIds: Set<string>;
    readonly areaIds: Set<string>;
    readonly connected: readonly StoredCapability[];
    readonly secrets: readonly string[];
}

// The area a card's folders come to: one that already names exactly them, else a new one. Undefined for no folder.
const areaFor = (card: LegacyCard, name: string, beside: Beside): string | undefined => {
    const folders = card.workspace?.folders;
    if (folders === undefined || folders.length === 0) {
        return undefined;
    }
    const standing = beside.standingAreas.find((area) => sameFolders(area.folders, folders));
    if (standing !== undefined) {
        return standing.id;
    }
    const id = freeId(`role-${card.id}`, beside.areaIds);
    beside.areas.push({ id, label: `${name} (role)`.slice(0, 60), folders: [...folders] });
    return id;
};

// The profile one card's limits come to, added beside the others; false when it limited nothing.
const profileFor = (card: LegacyCard, beside: Beside): boolean => {
    const name = card.label ?? card.id;
    const tools = ceilingOf(card.powers);
    const credentials = credentialsOf(card.powers, beside.connected, beside.secrets);
    const area = areaFor(card, name, beside);
    if (tools === undefined && credentials === undefined && card.workspace?.folders === undefined) {
        return false;
    }
    const profile: AccessProfile = {
        id: freeId(`role-${card.id}`, beside.profileIds),
        label: `${name} (role)`.slice(0, 60),
        brief: `What the role ${name} may reach, carried from its own card.`.slice(0, 200),
        roles: [card.id],
    };
    // An empty folder list fenced the card to nothing: an empty area list says the same.
    if (card.workspace?.folders !== undefined) {
        profile.areas = area === undefined ? [] : [area];
    }
    if (credentials !== undefined) {
        profile.credentials = credentials;
    }
    if (tools !== undefined) {
        profile.tools = tools;
    }
    beside.profiles.push(profile);
    return true;
};

export const roleAccessStep = defineStep({
    id: "role-limits-to-access-profiles",
    describe: "moves the limits each role card held on itself into an access profile that lists it, its folders into an area",
    plan: async ({ roots, read }) => {
        const rolesPath = join(roots.workspace, rolesDocument.path);
        const cards = entriesOf(await read(rolesPath), LegacyCardSchema);
        const moving = cards.read.filter(carries);
        if (moving.length === 0) {
            return undefined;
        }
        const profilesPath = join(roots.history, accessProfilesDocument.path);
        const areasPath = join(roots.workspace, areasDocument.path);
        const profiles = entriesOf(await read(profilesPath), Identified);
        const areas = entriesOf(await read(areasPath), StoredArea);
        const secretsParsed = z.record(z.string(), z.unknown()).safeParse(parseJsonOr((await read(join(roots.auth, SANDBOX_SECRETS))) ?? "", undefined));
        const beside: Beside = {
            profiles: [...profiles.raw],
            areas: [...areas.raw],
            standingAreas: areas.read,
            profileIds: new Set(profiles.read.map((entry) => entry.id)),
            areaIds: new Set(areas.read.map((entry) => entry.id)),
            connected: entriesOf(await read(join(roots.workspace, CAPABILITIES)), StoredCapability).read,
            secrets: secretsParsed.success ? Object.keys(secretsParsed.data) : [],
        };
        const moved = moving.filter((card) => profileFor(card, beside)).map((card) => card.id);
        const nextCards = cards.raw.map((raw) => {
            const card = LegacyCardSchema.safeParse(raw);
            return card.success && carries(card.data) ? withoutMoved(card.data) : raw;
        });
        const writes = new Map<string, string>([[rolesPath, canonical(nextCards)]]);
        const changes = [`takes the shelves, lists and folders off ${moving.length} role card(s)`];
        if (moved.length > 0) {
            writes.set(profilesPath, canonical(beside.profiles));
            writes.set(areasPath, canonical(beside.areas));
            changes.push(`writes an access profile listing each of ${moved.join(", ")} with the limits it held`);
        }
        if (moving.some((card) => credentialsOf(card.powers, [], []) !== undefined)) {
            changes.push("a card's connector, device or server list is kept as the connections standing today: one connected later is not added to it");
        }
        return { changes, writes };
    },
});
