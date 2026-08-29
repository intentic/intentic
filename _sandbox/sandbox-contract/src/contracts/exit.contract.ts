import { eventIterator, oc } from "@orpc/contract";
import { IntenticLineSchema } from "../events.js";
import { ExitCountriesSchema, ExitIdParamSchema, ExitListSchema, ExitObservationSchema, ExitUseInputSchema } from "../schemas/exit.js";
import { OkSchema } from "../schemas/shared.js";

// The live GEO EXIT surface. An exit is ADDED as an `exit` capability (which provider, a resting country,
// whether it comes up on boot); it is STARTED, MOVED and ROTATED here. Same split as the vpn contract and for
// the same reason: switching country is a runtime operation performed many times over one stored pool, by the
// operator from the Status card and by the agent through `exit` on its PATH, which calls these very routes.
//
// The difference from vpn is what "success" means. A dial succeeds when the tunnel is up; a country switch
// succeeds only when the egress ADDRESS has moved, which is why `use` and `rotate` end by fetching an
// ExitObservation through the exit's own proxy and fail when it does not agree with what was asked for.
//
// Nothing here changes the sandbox's default route, ever. Each exit publishes a SOCKS proxy and callers opt
// in; the daemon's own traffic, the model endpoint and the tunnel that makes this sandbox reachable stay on
// the plain uplink no matter what is up.
export const exitContract = {
    // Every configured exit with its live state, where it was asked to come out and where it actually does.
    // Drives the Status card, the browser account picker and `geo list` (the CLI is `geo`: `exit` is a shell
    // builtin, so a binary of that name is unreachable from a command line).
    list: oc
        .route({
            method: "GET",
            path: "/exit",
            summary: "Ways to come out somewhere else",
            description:
                "Every configured exit with its live state, the country it was asked to appear in, and the country it actually appears in. Those last two disagreeing is the whole reason this reports both.",
        })
        .output(ExitListSchema),
    // What this exit can reach, ranked by how much capacity is actually there. Live from the provider when it
    // answers (Tor's directory, VPN Gate's CSV, the pasted confs), from the baked fallback when it does not,
    // and `live` says which. This is what auto-fills the country picker instead of a user hunting hostnames.
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
    // Bring the exit up at its stored country. Streams, because a first start pulls a catalog, brings up a
    // tunnel and then verifies the address, which is tens of seconds on the free providers and can fail at
    // each step with something the user has to read. Idempotent: starting an up exit reports it and stops.
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
    // Move to another country, starting the exit first if it was down. Streams for the same reason as start,
    // and THROWS when the observed country does not end up matching: a switch that silently left traffic where
    // it was is the one failure mode this whole feature exists to make impossible.
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
    // A different address in the SAME country. Cheap on tor (a control-port signal), a re-dial to another
    // server on the rest. Fails when the address does not actually change, which on a small pool it can't.
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
    // What the world sees through this exit right now. Cheap, unstreamed, and the honest answer to "am I
    // actually in Germany", which is the question every other route here is judged against.
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
    // Take it down. Tolerates an already-down exit: "make it not be up" is the contract, not "it was up".
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
