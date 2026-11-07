import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { endpointIdOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { type KeyProvider, keyBeside, keyNamedByDefault } from "@intentic/sandbox-contract/models/key-providers";
import { t } from "@intentic/ui/i18n";
import { z } from "zod";
import { rowNote } from "../accountRows";

// WHAT A VENDOR'S API KEY SAYS AS A ROW of the provider card it is filed under (an Anthropic key under Claude): which key,
// who bills it, and whether it serves. Pure: the card hands in the keys the daemon files under the provider
// (providerCatalog.ts `keysBeside`) and the capability list, which only a reader who may change connections can read;
// for anyone else a key is named without its last characters and reads as serving, as the daemon lists it runnable.

export interface KeyRow {
    // The endpoint provider the key became, which a chat names to run on it.
    readonly provider: AgentProvider;
    // Its capability, which taking it off removes.
    readonly capability: string;
    readonly title: string;
    // What renaming it starts from and changes: the endpoint's own name, which is the drawn title only once the owner has
    // chosen one. Until then the row reads as the vendor's key and the field opens on the name it arrived under.
    readonly name: string;
    readonly note: string | undefined;
    readonly state: `connected` | `unknown` | `reauth`;
    // Something under way will move it by itself, which earns the note a spinner.
    readonly settling: boolean;
    // Why it does not serve, in the daemon's words.
    readonly description: string | undefined;
}

// The last characters the daemon echoes for a long key (endpoint.handler.ts keyHintOf), read where the list carries them.
// A capability's config is open-ended, so it is read through a schema, not assumed.
const HintSchema = z.object({ keyHint: z.string().min(1) });
const hintOf = (capability: CapabilitySummary | undefined): string | undefined => {
    const parsed = HintSchema.safeParse(capability?.config);
    return parsed.success ? parsed.data.keyHint : undefined;
};

// What the row is called and what follows its name. A name the owner gave the key is what they will look for, so it leads
// and the key's last characters follow it; a key still under the name it arrived with reads as the vendor's key. Who bills
// it is the one thing a key row says that an account row never does; its arrival name only where two keys would read alike.
const naming = (
    id: string,
    hint: string | undefined,
    vendor: KeyProvider | undefined,
    twins: boolean,
) => {
    const keyTitle = hint === undefined ? t(`connect.providerKeys.title`) : t(`connect.providerKeys.titleHint`, { hint });
    if (vendor !== undefined && !keyNamedByDefault(id, vendor.id)) {
        return { title: id, extra: hint === undefined ? undefined : keyTitle };
    }
    return { title: keyTitle, extra: twins && hint === undefined ? id : undefined };
};

export const keyRows = (
    provider: AgentProvider,
    keys: readonly { readonly id: AgentProvider; readonly label: string }[],
    capabilities: readonly CapabilitySummary[],
): readonly KeyRow[] => {
    const vendor = keyBeside(provider);
    return keys.flatMap((key) => {
        const id = endpointIdOf(key.id);
        if (id === undefined) {
            return [];
        }
        const held = capabilities.find((entry) => entry.id === id);
        const status = held?.status;
        const serving = status === undefined || status.state === `active`;
        const { title, extra } = naming(id, hintOf(held), vendor, keys.length > 1);
        return [
            {
                provider: key.id,
                capability: id,
                title,
                name: id,
                note: rowNote([vendor === undefined ? undefined : t(`connect.providerKeys.billed`, { vendor: vendor.label }), extra]),
                state: serving ? `connected` : status.settling === true ? `unknown` : `reauth`,
                settling: !serving && status.settling === true,
                description: serving ? undefined : status.detail,
            },
        ];
    });
};
