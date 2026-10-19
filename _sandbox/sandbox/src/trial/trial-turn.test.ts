import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Config } from "../env.config.js";
import { type TellTrialTurn, type TrialTurnState, tellPlatform, withTrialTurn } from "./trial-turn.js";

// The daemon's half of the finish-the-turn grace: the platform counts the trial turns still open, so what is pinned here
// is that every turn which earned the grace closes, however it ends, and no other turn ever does.

const told = (graced: boolean) => {
    const states: TrialTurnState[] = [];
    const tell: TellTrialTurn = async (state) => {
        states.push(state);
        return state === `open` && graced;
    };
    return { tell, states };
};

async function* turn(events: readonly AgentEvent[], failWith?: Error): AsyncGenerator<AgentEvent> {
    yield* events;
    if (failWith !== undefined) {
        throw failWith;
    }
}

const drain = async (stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> => {
    const seen: AgentEvent[] = [];
    for await (const event of stream) {
        seen.push(event);
    }
    return seen;
};

const done: AgentEvent = { kind: `done` };

describe("a trial turn", () => {
    it("opens before the turn runs, passes every event through, and closes once it ends", async () => {
        const platform = told(true);

        expect(await drain(withTrialTurn(platform.tell, () => turn([done])))).toEqual([done]);
        expect(platform.states).toEqual([`open`, `close`]);
    });

    it("never closes a turn that earned no grace, so it can't end another turn's", async () => {
        const platform = told(false);

        await drain(withTrialTurn(platform.tell, () => turn([done])));
        expect(platform.states).toEqual([`open`]);
    });

    it("closes a turn that failed partway", async () => {
        const platform = told(true);

        await expect(drain(withTrialTurn(platform.tell, () => turn([], new Error(`translator gone`))))).rejects.toThrow(`translator gone`);
        expect(platform.states).toEqual([`open`, `close`]);
    });

    it("closes a turn its reader stopped reading", async () => {
        const platform = told(true);
        const stream = withTrialTurn(platform.tell, () => turn([done, done]));

        await stream.next();
        await stream.return(undefined);
        expect(platform.states).toEqual([`open`, `close`]);
    });

    it("earns nothing, and asks nothing, where there is no platform to tell", async () => {
        const warn = jest.fn();
        // SAFETY: with no platform URL and no connect token, tellPlatform reads nothing else of the config before it answers.
        const config = { platform: { url: `` }, connectToken: `` } as Config;
        const tell = tellPlatform({ config, logger: { warn } });

        expect(await tell(`open`)).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });
});
