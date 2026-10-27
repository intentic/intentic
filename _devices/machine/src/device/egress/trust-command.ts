import type { Footnote } from "@intentic/local-agent";
import { buildRouteMap, type CommandContext } from "@stricli/core";
import { buildCommand, machineUi } from "../../cli-ui.js";
import { type EgressPin, egressPinStore, egressPinsPath } from "./pins.js";

// `intentic-machine egress trust <slug> [--reset]`: the passkeys this machine pinned for loosening a sandbox's egress
// fence (pins.ts), shown or forgotten. A door on the machine itself, so it needs nothing more than the person at it:
// after a reset, the next `set-egress` that carries the owner's passkeys pins them again on first use.

interface TrustFlags {
    readonly reset: boolean;
}

const when = (ms: number): string => new Date(ms).toISOString();

// One pin as facts, for the report. Pure.
const pinFields = (pin: EgressPin): Footnote[] => [
    ["sandbox", `${pin.slug}${pin.sandboxId === null ? "" : ` (id ${pin.sandboxId})`}`],
    ["passkeys for", `${pin.owner.rpId}, from ${pin.owner.origins.join(", ")}`],
    ...pin.owner.keys.map((key): Footnote => [key.name ?? "passkey", `${key.id}${pin.counters[key.id] === undefined ? "" : `, counter ${pin.counters[key.id]}`}`]),
    ["pinned", `${when(pin.pinnedAt)}, handed over by ${pin.pinnedBy}`],
    ...(pin.replacedAt === undefined ? [] : [["moved to these keys", when(pin.replacedAt)] satisfies Footnote]),
];

const trust = buildCommand<TrustFlags, [string]>({
    docs: { brief: "Show the passkeys this machine trusts to loosen a sandbox's egress fence, or forget them (--reset)" },
    parameters: {
        positional: { kind: "tuple", parameters: [{ brief: "The sandbox, as `intentic-machine sandbox list` names it", parse: String, placeholder: "slug" }] },
        flags: { reset: { kind: "boolean", brief: "Forget the pinned passkeys; the next change from the editor that carries them pins them again", default: false } },
    },
    async func(this: CommandContext, flags: TrustFlags, slug: string) {
        const ui = machineUi(this.process);
        const store = egressPinStore();
        if (flags.reset) {
            ui.act(`Forgetting the passkeys pinned for ${slug}`);
            const dropped = await store.reset(slug);
            ui.done(dropped === 0 ? `No passkeys were pinned for ${slug}.` : `Forgot the passkeys pinned for ${slug}.`);
            ui.later([["pin them again", "turn the fence on or save it once from the editor"]]);
            return;
        }
        const pins = await store.list(slug);
        if (pins.length === 0) {
            ui.quiet(`No passkeys are pinned for ${slug} on this machine (${egressPinsPath}).`);
            ui.later([["change its fence here", `ic sandbox egress ${slug}`]]);
            return;
        }
        ui.report(`egress trust: ${slug}`, egressPinsPath);
        for (const pin of pins) {
            ui.fields(pinFields(pin));
        }
        ui.later([["forget them", `intentic-machine egress trust ${slug} --reset`]]);
    },
});

export const egressRoutes = buildRouteMap({
    routes: { trust },
    docs: { brief: "The egress fence's trust on this machine: which passkeys may loosen a sandbox's fence from the editor" },
});
