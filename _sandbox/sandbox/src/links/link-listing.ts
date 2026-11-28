import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { LinkHello } from "@intentic/sandbox-contract/schemas/links";
import type { TurnStanding } from "../conversations/actor/turn-standing.js";
import { opt } from "../opt.js";
import type { linkHello,LinkAnswerOf } from "../sandboxes/link-client.js";
import { isLinkCard, sandboxNameOf } from "./linked-destinations.js";

// One link card as `links` lists it for the agent: where it goes, whether that sandbox answers right now, the terms its
// tasks run under there, whether its owner shares its records with this sandbox (`--on <link>`, its records tools), and
// whether this link may operate it (its run_command, read_file and write_file tools).
export interface LinkListing {
    readonly to: string;
    readonly sandbox: string;
    readonly online: boolean;
    readonly why?: string;
    readonly role?: string;
    readonly approve?: boolean;
    readonly turnsPerHour?: number;
    readonly records?: boolean;
    // Whether this link may operate that sandbox: run commands, read and write files there as its owner's terminal would.
    readonly operate?: boolean;
}

// How long `links` waits on each linked sandbox's answer before calling it offline.
const HELLO_MS = 8_000;

/** The link cards this conversation's turn was granted (one, with `only`), each with whether it answers and its terms. */
export const listLinkCards = async (
    deps: {
        readonly capabilities: () => Promise<readonly Capability[]>;
        readonly standingOf: (conversationId: string) => TurnStanding | undefined;
        readonly wire: { readonly hello: typeof linkHello };
    },
    conversationId: string,
    only?: string,
): Promise<readonly LinkListing[]> => {
    const standing = deps.standingOf(conversationId);
    const cards = (await deps.capabilities())
        .filter(isLinkCard)
        .filter((card) => (standing === undefined || standing.granted.includes(card.id)) && (only === undefined || card.id === only));
    return Promise.all(
        cards.map(async (card): Promise<LinkListing> => {
            const hello: LinkAnswerOf<LinkHello> = await deps.wire.hello({ id: card.id, config: card.config }, AbortSignal.timeout(HELLO_MS));
            if (!hello.ok) {
                return { to: card.id, sandbox: sandboxNameOf(card), online: false, why: hello.message };
            }
            const { terms } = hello.value;
            return {
                to: card.id,
                // The name the owner knows it by, from pairing; what it calls itself is only its container's name.
                sandbox: card.config.name ?? hello.value.sandbox,
                online: true,
                ...opt("role", terms.role),
                approve: terms.approve,
                turnsPerHour: terms.turnsPerHour,
                records: terms.records === true,
                operate: terms.operate === true,
            };
        }),
    );
};
