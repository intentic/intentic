import { errorMessage } from "@intentic/base/errors";
import type { AgentLaunchCard } from "@intentic/extension-api";
import { sandboxShallowRef } from "@intentic/extension-api";
import { uuid } from "../../../lib/uuid";

// AN AGENT STARTED FROM A PRESS ELSEWHERE, ON THE BOARD BEFORE IT EXISTS (api.chat.launchAgent: Pipelines' Fix with
// agent). The sandbox answers such a press only once it has read what the agent is handed (a failed run's job list and
// its logs: three seconds and more), and the board used to stay as it was until then, so the press read as lost. Now the
// board opens at the press with a dashed card standing in for the agent, saying what the start waits on and for how
// long; the agent's own card takes its place once the roster holds it, and a refusal stays on it in the sandbox's words.

export interface AgentLaunch {
    readonly key: string;
    readonly title: string;
    readonly note?: string | undefined;
    // The press, on this browser's clock: the card counts from it.
    readonly at: number;
    // Where the press was made, for the refused card's way back; `label` names it when the app knows a name for it.
    readonly from?: { readonly path: string; readonly label?: string | undefined } | undefined;
    // The conversation the start answered with: the card gives way once the roster holds it.
    readonly conversationId?: string | undefined;
    // The refusal, in the sandbox's words.
    readonly failure?: string | undefined;
}

// Sandbox-scoped: a switch takes presses made on another daemon off this board.
export const launches = sandboxShallowRef<readonly AgentLaunch[]>(() => []);

// How long an answered launch is kept after the answer, for the roster to catch up: its frame lands within a second or
// two, and one lost to a reconnect must not leave the card standing for good.
export const HANDOVER_MS = 15_000;

const patch = (key: string, fields: Partial<AgentLaunch>): void => {
    launches.value = launches.value.map((launch) => (launch.key === key ? { ...launch, ...fields } : launch));
};

export const dismissLaunch = (key: string): void => {
    launches.value = launches.value.filter((launch) => launch.key !== key);
};

// The launches the board draws, newest first: every one whose agent the roster does not hold yet, refused ones included.
export const standingLaunches = (all: readonly AgentLaunch[], held: (conversationId: string) => boolean): readonly AgentLaunch[] =>
    all.filter((launch) => launch.conversationId === undefined || !held(launch.conversationId));

// What a launch does to the app around it, handed in so this module holds no router and no notification lane.
export interface LaunchEffects {
    // Where the reader is now, read before the board opens.
    readonly here: () => AgentLaunch[`from`];
    readonly openBoard: () => void;
    // Whether the reader is still on the board: the agent is then focused there and a refusal said there; off it, the
    // reader is not pulled back, and a refusal is a toast.
    readonly onBoard: () => boolean;
    readonly focus: (conversationId: string) => void;
    readonly refused: (title: string, message: string) => void;
}

/** Draws `card` on the board and opens it, runs `start`, and hands the card over to the agent `start` answers with.
 *  A refusal is said on the card (or by `refused` once the reader has left the board), then thrown back. */
export const launchAgent = async <T extends { readonly conversationId: string }>(
    card: AgentLaunchCard,
    start: () => Promise<T>,
    effects: LaunchEffects,
): Promise<T> => {
    const key = uuid();
    const from = effects.here();
    // Before the board opens, so its first frame already holds the card.
    launches.value = [{ key, title: card.title, note: card.note, at: Date.now(), from }, ...launches.value];
    effects.openBoard();
    try {
        const answer = await start();
        patch(key, { conversationId: answer.conversationId });
        setTimeout(() => dismissLaunch(key), HANDOVER_MS);
        if (effects.onBoard()) {
            effects.focus(answer.conversationId);
        }
        return answer;
    } catch (error) {
        const message = errorMessage(error);
        if (effects.onBoard()) {
            patch(key, { failure: message });
        } else {
            dismissLaunch(key);
            effects.refused(card.title, message);
        }
        throw error;
    }
};
