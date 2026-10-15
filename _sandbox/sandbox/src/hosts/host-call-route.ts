import { HOST_NATIVE_ENVIRONMENT } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import type { Services } from "../composition.js";
import type { PeerCallRoute } from "../peers/peer-routes.js";
import { hostConnectionOf } from "./host-connection.js";

// A CALL NAMING A DISTRO GOES TO THAT DISTRO WHILE THE WINDOWS SIDE IS DOWN (2026-10-15). A turn mounts one server per
// card, and a card's key is its Windows side, so every call to "rog" went to that one socket. On 10-13 rog's Windows
// agent was uninstalled while the agent in its WSL distro stayed connected, and for two days every call was refused as
// "not connected", `run_command` with `in: "wsl:archlinux"` included, though the agent that IS archlinux held a live
// socket the whole time. So, only while the Windows side holds no socket: a call whose `in` names a distro that does is
// sent to that distro's own agent with `in` dropped (the agent is that environment, and a distro's agent refuses an
// `in` naming a distro), and any other call is refused with the sides that ARE up and how to reach them. While the
// Windows side is up nothing changes: a call crosses into the distro through it, as it always has.
//
// The safety gate then judges the call as it is sent, against the distro's connection. Nothing in it reads a dialect or a
// platform (the classifier reads the command line alone, the switches are the card's whichever side asks), so this only
// makes the card and the safety log name the environment the command runs in.

// A call's `in`, the one argument read here; every other argument goes on exactly as the model sent it.
const CrossingSchema = z.object({ params: z.object({ arguments: z.looseObject({ in: z.string().min(1) }) }) });

/** The side a call's `in` names, as the environment key its enrollment records (`wsl:<distro>`), and the call without it. */
const crossingOf = (message: RpcMessage): { readonly named: string; readonly rest: RpcMessage } | undefined => {
    const parsed = CrossingSchema.safeParse(message);
    if (!parsed.success) {
        return undefined;
    }
    // The distro's own agent IS that environment, and refuses an `in` naming a distro, so the crossing is dropped.
    const { in: named, ...rest } = parsed.data.params.arguments;
    return { named, rest: { ...message, params: { ...message.params, arguments: rest } } };
};

// A distro by the name WSL knows it by, which is what `in` takes; any other side by its key.
const sideName = (environment: string): string => (environment.startsWith("wsl:") ? environment.slice("wsl:".length) : environment);

const spokenList = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);

/** What the agent reads when the Windows side is down and its call did not name a side that is up. Exported for its test. */
export const partlyConnectedRefusal = (card: string, awake: readonly string[], named: string | undefined): string => {
    const names = awake.map(sideName);
    const crossings = awake.map((environment) => `in: "${environment}"`);
    const down =
        named === undefined
            ? `"${card}" (its Windows side) is not connected right now`
            : `Nothing on "${card}" answers to in: "${named}" right now, and its Windows side is not connected either`;
    const sides = names.length === 1 ? `Its WSL side ${names[0] ?? ""} is` : `Its WSL sides ${spokenList(names)} are`;
    const how = crossings.length === 1 ? `pass ${crossings[0] ?? ""} to run_command to run there` : `pass ${crossings.join(" or ")} to run_command to run in one`;
    return (
        `${down}: its agent there is not running or cannot reach this sandbox. ${sides}: ${how}. ` +
        `Every other tool reaches the Windows side only, so it waits until that side is back.`
    );
};

/** The hosts door's `route` (peers/peer-routes.ts): where a call to a card's mount actually goes. */
export const hostCallRoute =
    (services: Pick<Services, "hosts" | "hostHub">) =>
    async (id: string, message: RpcMessage): Promise<PeerCallRoute | undefined> => {
        // The handshake and the tool list are answered for the card as before; only a call has somewhere else to go.
        if (message.method !== "tools/call" || services.hostHub.online(id)) {
            return undefined;
        }
        const { card, environment } = await hostConnectionOf(services, id);
        if (environment !== HOST_NATIVE_ENVIRONMENT) {
            return undefined;
        }
        const awake = (await services.hosts.list()).filter(
            (entry) => entry.card === card && entry.environment !== HOST_NATIVE_ENVIRONMENT && services.hostHub.online(entry.id),
        );
        // Nothing of this computer answers: the door's own "not connected" stands, as it always has.
        if (awake.length === 0) {
            return undefined;
        }
        const crossing = crossingOf(message);
        // WSL's own names are case-blind (`wsl -d ArchLinux` finds archlinux), so a model's spelling is too.
        const side = crossing === undefined ? undefined : awake.find((entry) => entry.environment.toLowerCase() === crossing.named.toLowerCase());
        if (side !== undefined && crossing !== undefined) {
            return { id: side.id, message: crossing.rest };
        }
        return { refusal: partlyConnectedRefusal(card, awake.map((entry) => entry.environment).toSorted(), crossing?.named) };
    };
