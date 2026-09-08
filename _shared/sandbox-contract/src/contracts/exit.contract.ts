import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events/system-events.js";
import { ExitCountriesSchema, ExitIdParamSchema, ExitListSchema, ExitObservationSchema, ExitUseInputSchema } from "../schemas/exit.js";
import { OkSchema } from "../schemas/shared.js";

// An exit is added as an `exit` capability; started, moved and rotated here, since switching country is a
// runtime operation done both by the operator and by the agent's `exit` command on PATH. Each exit publishes an opt-in
// SOCKS proxy; the sandbox's default route, model endpoint and reachability tunnel never move.
export const exitContract = {
    // Drives the capability card, the account picker and `geo list` (the CLI is `geo`; `exit` is a shell builtin).
    list: oc
        .route({
            method: "GET",
            path: "/exit",
            summary: "Ways to come out somewhere else",
            description:
                "Every configured exit with its live state, the country it was asked to appear in, and the country it actually appears in. Those last two disagreeing is the whole reason this reports both.",
        })
        .output(ExitListSchema),
    // "Provider" is Tor's directory, VPN Gate's CSV, or pasted confs; this is what auto-fills the country picker.
    countries: oc
        .route({
            method: "GET",
            path: "/exit/{id}/countries",
            summary: "Countries one exit can reach",
            description:
                "Where this exit can put you, ranked by how much capacity is really there. Asked of the provider when it answers and taken from a built-in list when it does not, and the answer says which of those you got.",
        })
        .input(ExitIdParamSchema)
        .output(ExitCountriesSchema),
    start: oc
        .route({
            method: "POST",
            path: "/exit/{id}/start",
            summary: "Bring an exit up",
            description:
                "Starts the exit in the country it was configured for. Streamed, because a first start fetches a catalogue, raises a tunnel and then checks the address, which takes tens of seconds on the free providers and can fail at each step with something worth reading. Starting one that is already up simply says so.",
        })
        .input(ExitIdParamSchema)
        .output(eventIterator(IntenticLineSchema)),
    use: oc
        .route({
            method: "POST",
            path: "/exit/{id}/use",
            summary: "Move to another country",
            description:
                "Switches the exit's country, starting it first if it was down. It ends by checking where the world actually sees you and fails if that does not match what you asked for. A switch that quietly left your traffic where it was is the exact failure this whole feature exists to rule out.",
        })
        .input(ExitUseInputSchema)
        .output(eventIterator(IntenticLineSchema)),
    // Cheap on tor (a control-port signal); a re-dial to another server for everything else.
    rotate: oc
        .route({
            method: "POST",
            path: "/exit/{id}/rotate",
            summary: "Take a different address, same country",
            description:
                "Swaps to another address in the country you are already in. Fails if the address does not actually change, which on a small pool it sometimes cannot.",
        })
        .input(ExitIdParamSchema)
        .output(eventIterator(IntenticLineSchema)),
    check: oc
        .route({
            method: "POST",
            path: "/exit/{id}/check",
            summary: "Where the world sees you right now",
            description:
                "Looks up the address and country as seen through this exit. Cheap, and the honest answer to whether you are really where you meant to be, which is what every other call here is judged against.",
        })
        .input(ExitIdParamSchema)
        .output(ExitObservationSchema),
    stop: oc
        .route({
            method: "POST",
            path: "/exit/{id}/stop",
            summary: "Take an exit down",
            description:
                "Shuts the exit off. One that was already down is fine: the promise is that it is not up afterwards, not that it was up before.",
        })
        .input(ExitIdParamSchema)
        .output(OkSchema),
};
