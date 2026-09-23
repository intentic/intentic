// One visit's dealings with the platform over the hosted machine on its row, as one value only `stepHosted` moves: what
// is in flight (a provision, a restart, a hand-back) and what the platform was asked for and has not settled. `action`
// is the generation every answer is checked against; each start, and the page going away, moves it on.

// Asked of the platform and not settled: nothing; a machine (leaving the lane must cancel it); or a hand-back the
// platform has not confirmed (the registry poll holds off meanwhile, and leaving asks for it again).
export type HostedAsk = `nothing` | `machine` | `release`;

export type HostedLane =
    | { readonly kind: `idle`; readonly action: number; readonly asked: HostedAsk }
    | { readonly kind: `provisioning`; readonly action: number; readonly asked: Exclude<HostedAsk, `nothing`> }
    // The wait's one recovery: the machine restarted, or released and built again.
    | { readonly kind: `restarting`; readonly action: number; readonly asked: HostedAsk }
    | { readonly kind: `releasing`; readonly action: number; readonly asked: `release` };

export type HostedEvent =
    | { readonly kind: `provision` }
    | { readonly kind: `restart` }
    // A provision or restart answered, either way, under the action it started with.
    | { readonly kind: `settled`; readonly action: number }
    | { readonly kind: `release` }
    | { readonly kind: `released` }
    | { readonly kind: `refused` }
    // The page went away: every answer still in flight is stale from here.
    | { readonly kind: `left` };

export const HOSTED_IDLE: HostedLane = { kind: `idle`, action: 0, asked: `nothing` };

type Moves = { readonly [K in HostedEvent["kind"]]: (lane: HostedLane, event: Extract<HostedEvent, { kind: K }>) => HostedLane };

// Every move there is, one per event; a lane an event names no move from is left as it is.
const MOVES: Moves = {
    provision: (lane) =>
        lane.kind === `idle` ? { kind: `provisioning`, action: lane.action + 1, asked: lane.asked === `release` ? `release` : `machine` } : lane,
    restart: (lane) => (lane.kind === `idle` ? { kind: `restarting`, action: lane.action + 1, asked: lane.asked } : lane),
    settled: (lane, { action }) =>
        (lane.kind === `provisioning` || lane.kind === `restarting`) && lane.action === action ? { kind: `idle`, action, asked: lane.asked } : lane,
    // A hand-back supersedes whatever was in flight, so the answers to it arrive stale.
    release: (lane) => ({ kind: `releasing`, action: lane.action + 1, asked: `release` }),
    released: (lane) => (lane.kind === `releasing` ? { kind: `idle`, action: lane.action, asked: `nothing` } : lane),
    refused: (lane) => (lane.kind === `releasing` ? { kind: `idle`, action: lane.action, asked: `release` } : lane),
    left: (lane) => ({ ...lane, action: lane.action + 1 }),
};

// The table is keyed by the event's own kind, so the entry read always takes the event it is handed.
export const stepHosted = (lane: HostedLane, event: HostedEvent): HostedLane =>
    (MOVES[event.kind] as (lane: HostedLane, event: HostedEvent) => HostedLane)(lane, event);

// A provision or restart in flight: the rung, its buttons and the wake reflex all wait on it.
export const laneBusy = (lane: HostedLane): boolean => lane.kind === `provisioning` || lane.kind === `restarting`;

// Leaving the hosted lane must first have the platform take back what this visit asked for.
export const owesHandBack = (lane: HostedLane): boolean => lane.asked !== `nothing` || laneBusy(lane);
