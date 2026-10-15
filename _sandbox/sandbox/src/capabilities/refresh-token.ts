import type { CapabilityContribution } from "@intentic/extension-manifest";
import { type Capability, envSuffix } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import { tokenEquals } from "../auth/token-equals.js";
import type { CapabilitiesStore } from "./capabilities-store.js";
import { contributionFor, type ResolvedContribution } from "./contributions.js";

// A delegated sign-in's refresh token reaches its card here, from the CLI that ran the sign-in or the listener process
// that rotated it, rather than being printed for someone to paste. Only a card whose manifest declares `refreshToken`
// takes one, only into the field that names, only from a caller presenting the card's current token (empty before the
// first sign-in, so an id guessed from outside replaces nothing), and only while the fields the sign-in was made
// against still hold what they held then. Nothing is returned, and the store's vault keeps the value out of
// capabilities.json.
//
// No manifest version per write: Microsoft hands out a new refresh token with every access token, so a rotation is
// routine upkeep, not a settings change anyone would want to step back through.

export interface RefreshTokenInput {
    readonly id: string;
    readonly binding: Readonly<Record<string, string>>;
    readonly previous: string;
    readonly refreshToken: string;
    readonly login?: boolean | undefined;
}

type CliCard = Extract<Capability, { kind: "cli" }>;
type CliSpec = Extract<CapabilityContribution, { kind: "cli" }>;

interface SignInCard {
    readonly card: CliCard;
    readonly spec: CliSpec;
    readonly declared: NonNullable<CliSpec["refreshToken"]>;
    readonly extension: string;
}

// The card a CLI names, by its id as the owner typed it or as the CLI knows it from its per-instance env suffix, with
// the manifest entry that declares its sign-in.
const signInCard = async (
    store: Pick<CapabilitiesStore, "get" | "list">,
    registry: ReadonlyMap<string, ResolvedContribution>,
    id: string,
): Promise<SignInCard> => {
    const card = (await store.get(id)) ?? (await store.list()).find((entry) => envSuffix(entry.id) === envSuffix(id));
    if (card?.kind === "cli") {
        const contribution = contributionFor(registry, card.kind, card.config);
        if (contribution?.spec.kind === "cli" && contribution.spec.refreshToken !== undefined) {
            return { card, spec: contribution.spec, declared: contribution.spec.refreshToken, extension: contribution.extension.id };
        }
    }
    throw new ORPCError("NOT_FOUND", { message: "no connection under that id takes a delegated sign-in" });
};

// A field left at its default is stored empty or not at all; it still holds the default the sign-in saw.
const currentValue = (target: SignInCard, key: string): string =>
    (target.card.config[key] ?? "") || (target.spec.fields.find((field) => field.key === key)?.default ?? "");

export const storeRefreshToken = async (
    store: Pick<CapabilitiesStore, "get" | "list" | "upsert">,
    registry: ReadonlyMap<string, ResolvedContribution>,
    input: RefreshTokenInput,
    // The extension a listener process calls as; undefined for the agent's own CLI.
    caller: string | undefined,
): Promise<void> => {
    const target = await signInCard(store, registry, input.id);
    if (caller !== undefined && caller !== target.extension) {
        throw new ORPCError("FORBIDDEN", { message: `"${target.card.id}" is not a connection extension "${caller}" contributes` });
    }
    const moved = target.declared.boundTo.find((key) => currentValue(target, key) !== (input.binding[key] ?? ""));
    if (moved !== undefined) {
        throw new ORPCError("CONFLICT", { message: `the connection's ${moved} changed during sign-in: sign in again` });
    }
    if (!tokenEquals(target.card.config[target.declared.field] ?? "", input.previous)) {
        throw new ORPCError("CONFLICT", { message: "the connection's token already changed" });
    }
    // `signedInAt` moves only on an interactive sign-in: a listener keys its connection on it, so a fresh sign-in reopens
    // a watcher a refused token had paused, while the hourly rotation leaves it running.
    const signedIn = input.login === true ? { signedInAt: String(Date.now()) } : undefined;
    await store.upsert({ ...target.card, config: { ...target.card.config, [target.declared.field]: input.refreshToken, ...signedIn } });
};
