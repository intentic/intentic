import { unstubbed } from "@intentic/testing";
import { turnDoors } from "../agent/run/turn/turn-doors.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import type { Said, Steer, TurnInput, TurnStarter } from "./turn-starter.js";

// These services with every TurnStarter door running `body` over them, the way composition binds streamAgent: the
// engine's own start, resume, run and stop, around a turn the suite scripts.
export const drivenBy = (services: Services, body: TurnStarter["stream"]): Services => {
    const driven: Services = unstubbed<Services>("services", { ...services, turns: turnDoors(() => driven, body) });
    return driven;
};

// The TurnStarter port's wake door, recording what it was handed the way admission would take it: nowhere for words not a
// person's while `archived`, said into the live turn while `live`, queued while `busy` counts down (Infinity: every one
// until reset), a turn of its own otherwise; never answered while `stuck`, as a daemon dying mid-delivery.
export interface FakeTurns {
    readonly turns: Pick<TurnStarter, "say">;
    readonly steers: Steer[];
    readonly started: (TurnInput & { readonly conversationId: string })[];
    readonly queued: Said[];
    live: boolean;
    busy: number;
    stuck: boolean;
    archived: boolean;
}

export const fakeTurns = (over: { readonly live?: boolean; readonly busy?: number; readonly archived?: boolean } = {}): FakeTurns => {
    const fake: FakeTurns = {
        steers: [],
        started: [],
        queued: [],
        live: over.live === true,
        busy: over.busy ?? 0,
        stuck: false,
        archived: over.archived === true,
        turns: {
            say: async (said) => {
                if (fake.stuck) {
                    return new Promise<never>(() => undefined);
                }
                if (fake.archived && said.voice !== "person") {
                    return { why: "the conversation is archived, and only a person's message reopens it" };
                }
                if (fake.live) {
                    fake.steers.push({ text: said.turn.prompt, voice: said.voice, ...opt("outside", said.outside) });
                    return { delivered: "steered", run: "run-live" };
                }
                if (fake.busy > 0) {
                    fake.busy -= 1;
                    fake.queued.push(said);
                    return { delivered: "queued" };
                }
                fake.started.push({ ...said.turn, ...opt("outsideWake", said.outside) });
                return { delivered: "started", run: `run-${fake.started.length}` };
            },
        },
    };
    return fake;
};
