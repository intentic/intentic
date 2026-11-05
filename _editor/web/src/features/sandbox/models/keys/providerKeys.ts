import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { endpointIdOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { keyBeside } from "@intentic/sandbox-contract/models/key-providers";
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

export const keyRows = (
    provider: AgentProvider,
    keys: readonly { readonly id: AgentProvider; readonly label: string }[],
    capabilities: readonly CapabilitySummary[],
): readonly KeyRow[] => {
    const vendor = keyBeside(provider)?.label;
    return keys.flatMap((key) => {
        const id = endpointIdOf(key.id);
        if (id === undefined) {
            return [];
        }
        const held = capabilities.find((entry) => entry.id === id);
        const hint = hintOf(held);
        const status = held?.status;
        const serving = status === undefined || status.state === `active`;
        return [
            {
                provider: key.id,
                capability: id,
                title: hint === undefined ? t(`connect.providerKeys.title`) : t(`connect.providerKeys.titleHint`, { hint }),
                // Who bills it is the one thing a key row says that an account row never does. Its own name only where two
                // keys would otherwise read alike.
                note: rowNote([
                    vendor === undefined ? undefined : t(`connect.providerKeys.billed`, { vendor }),
                    keys.length > 1 && hint === undefined ? key.label : undefined,
                ]),
                state: serving ? `connected` : status.settling === true ? `unknown` : `reauth`,
                settling: !serving && status.settling === true,
                description: serving ? undefined : status.detail,
            },
        ];
    });
};
