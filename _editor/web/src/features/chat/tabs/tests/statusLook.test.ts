// ONE CHAT, ONE GLYPH, IN THE HEADER AND ON THE RAIL. The chat's header once drew the window's own status (its error line,
// a crash flag a reload resets, its own stream), so after a reload the header said idle while the board said error, and a
// turn another window started, a resume or a land never showed there at all. Both now read statusLook.ts: the card
// first, the conversation's own status only where there is no card.
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { AgentStatusSchema, type AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import { agentStatusMeta, cornerInk } from "../../../../models/agent-status/agentStatus-meta";
import { NO_ATTENTION } from "../../../../models/agent-status/agentStatus-lanes";
import type { ClientAgentStatus } from "../../../../models/agent-status/agentStatus-standing";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { Conversation } from "../../../../models/conversations/session/conversation";
import { runningTurn } from "../../../../testing/runningTurn";
import { statusIcon, statusLabel, statusTabClass } from "../../models/catalog";
import { createCardViews } from "../cardView";
import { headerGlyph, statusLookOf } from "../statusLook";

const cardOf = (status: AgentStatus | ClientAgentStatus): FleetAgent => ({
    id: `c1`,
    title: `Fix the parser`,
    provider: `claude`,
    harness: `native`,
    status,
    updatedAt: 0,
    attention: NO_ATTENTION,
    open: true,
    unread: false,
    unsent: false,
});

// The rail's corner for one chat, as a row is handed it.
const railStatus = (conversation: Conversation, agent: FleetAgent | undefined) => createCardViews().of({ conversation, agent }, undefined, 0).status;

afterEach(() => resetSandboxScope());

describe(`whose word the glyph is`, () => {
    it(`is the card's over the window's own, for a turn another window started and after a reload`, () => {
        const chat = new Conversation(`c1`);

        // Idle here, running on the board: another window's turn this window is not attached to.
        expect(statusLookOf(chat, cardOf(`running`))).toMatchObject({ name: `spinner`, spin: true, label: agentStatusMeta(`running`).label });
        // A reload reset the window's crash flag; the board still says error.
        expect(statusLookOf(chat, cardOf(`error`))).toMatchObject({ name: `exclamation-triangle`, title: `text-danger` });
        // A failure line here, and the card already running the next turn.
        chat.error.value = `The sandbox did not answer.`;
        expect(chat.status.value).toBe(`error`);
        expect(statusLookOf(chat, cardOf(`running`)).name).toBe(`spinner`);
    });

    it(`says what the window's own status never could: resuming, landing, interrupted`, () => {
        const chat = new Conversation(`c1`);
        for (const status of [`resuming`, `landing`, `interrupted`] as const) {
            expect(statusLookOf(chat, cardOf(status)).label).toBe(agentStatusMeta(status).label);
        }
    });

    it(`is the window's own where there is no card, exactly as the tab drew it before`, () => {
        const chat = new Conversation(`c1`);
        const own = () => statusLookOf(chat, undefined);
        expect(own()).toEqual({
            name: statusIcon(`idle`).name,
            spin: undefined,
            label: statusLabel(`idle`),
            header: statusIcon(`idle`).class,
            corner: `text-xs ${cornerInk(statusIcon(`idle`).class)}`,
            title: statusTabClass(`idle`),
            cornered: true,
        });

        runningTurn(chat.turn);
        expect(headerGlyph(own())).toEqual({ spin: undefined, ...statusIcon(`streaming`) });
        expect(own().title).toBe(`text-link`);
        chat.error.value = `The sandbox did not answer.`;
        expect(headerGlyph(own())).toEqual({ ...statusIcon(`error`), spin: undefined });
        expect(own().label).toBe(statusLabel(`error`));
    });
});

describe(`the header and the rail`, () => {
    const every = [...AgentStatusSchema.options, `draft`, `starting`, `failed`, `resumed`] as const;

    it.each(every)(`draw a %s card with the same glyph, label and ink`, (status) => {
        const chat = new Conversation(`c1`);
        const card = cardOf(status);
        const look = statusLookOf(chat, card);
        const meta = agentStatusMeta(status);

        expect({ name: look.name, spin: look.spin, label: look.label }).toEqual({ name: meta.icon, spin: meta.spin, label: meta.label });
        expect(look.header.endsWith(` ${meta.class}`)).toBe(true);
        // The rail's corner: the same glyph, in its quiet ink, or none for a card that never started.
        const rail = railStatus(chat, card);
        if (status === `draft`) {
            expect(rail).toBeUndefined();
            return;
        }
        expect(rail).toEqual({ name: look.name, spin: look.spin, class: look.corner, "aria-label": look.label });
        expect(look.corner).toBe(`text-xs ${cornerInk(meta.class)}`);
    });

    it(`draw a chat with no card from its own status, the same in both`, () => {
        const chat = new Conversation(`c1`);
        runningTurn(chat.turn);
        const look = statusLookOf(chat, undefined);

        expect(railStatus(chat, undefined)).toEqual({ name: look.name, spin: look.spin, class: look.corner, "aria-label": look.label });
        expect(headerGlyph(look)).toEqual({ spin: undefined, ...statusIcon(`streaming`) });
    });

    it(`colour the header's title as the tab did: working, waiting on you, failed`, () => {
        const chat = new Conversation(`c1`);
        const title = (status: AgentStatus) => statusLookOf(chat, cardOf(status)).title;

        const working: readonly AgentStatus[] = [`running`, `resuming`, `landing`];
        const quiet: readonly AgentStatus[] = [`idle`, `stopped`, `landed`, `stopping`];
        expect(working.map(title)).toEqual([`text-link`, `text-link`, `text-link`]);
        expect(title(`awaiting`)).toBe(`text-accent`);
        expect(title(`error`)).toBe(`text-danger`);
        expect(quiet.map(title)).toEqual([``, ``, ``, ``]);
    });

    it(`draw an idle card's dot as small as the tab's own idle dot`, () => {
        const chat = new Conversation(`c1`);
        expect(statusLookOf(chat, cardOf(`idle`)).header).toBe(statusIcon(`idle`).class);
    });
});
