import type {
    LocalRepairContext,
    LocalRepairHost,
    LocalRepairMessage,
    LocalRepairSession,
    LocalRepairTool,
} from "@intentic/web/local-host";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ref, type Ref } from "vue";

const REPAIR_EVENT = `desktop://repair`;

interface RawTool {
    readonly name: string;
    readonly state: string;
    readonly summary: string;
    readonly detail?: string;
    readonly approvalId?: string;
}

interface RawMessage {
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly tool?: RawTool;
}

interface RawSession {
    readonly state: string;
    readonly messages: readonly RawMessage[];
    /** While Repair's daily allowance is spent: when it resets (repair/mod.rs `allowance_resets_at`). */
    readonly allowanceResetsAt?: string;
}

const asTool = (tool: RawTool | undefined): LocalRepairTool | undefined => {
    if (tool === undefined) {
        return undefined;
    }
    const state = tool.state as LocalRepairTool[`state`];
    return {
        name: tool.name,
        state,
        summary: tool.summary,
        detail: tool.detail,
        approvalId: tool.approvalId,
    };
};

const asSessionState = (state: string): LocalRepairSession[`state`] => {
    if (state === `waitingApproval`) {
        return `waiting`;
    }
    return state as LocalRepairSession[`state`];
};

/**
 * The session as the app sends it, in the shape the Repair view draws. The allowance's reset rides along: dropped here
 * until 2026-10-12, a spent allowance read as Repair saying nothing back, with no word of when it would again.
 */
export const asSession = (raw: RawSession): LocalRepairSession => {
    const session: LocalRepairSession = {
        state: asSessionState(raw.state),
        messages: raw.messages.map(
            (message): LocalRepairMessage => ({
                id: message.id,
                role: message.role as LocalRepairMessage[`role`],
                text: message.text,
                tool: asTool(message.tool),
            }),
        ),
    };
    if (raw.allowanceResetsAt === undefined) {
        return session;
    }
    return { ...session, allowanceResetsAt: raw.allowanceResetsAt };
};

export const repairHost = (): LocalRepairHost => {
    const session: Ref<LocalRepairSession> = ref({ state: `idle`, messages: [] });
    let unlisten: UnlistenFn | undefined;

    const sync = async (): Promise<void> => {
        const raw = (await invoke(`repair_state`)) as RawSession;
        session.value = asSession(raw);
    };

    const ensureListen = async (): Promise<void> => {
        if (unlisten !== undefined) {
            return;
        }
        unlisten = await listen<RawSession>(REPAIR_EVENT, (event) => {
            session.value = asSession(event.payload);
        });
        await sync();
    };

    return {
        session,
        start: async (context?: LocalRepairContext) => {
            await ensureListen();
            await invoke(`repair_start`, { context: context ?? null });
        },
        send: async (text: string) => {
            await ensureListen();
            await invoke(`repair_send`, { text });
        },
        answer: async (approvalId: string, allow: boolean) => {
            await ensureListen();
            await invoke(`repair_answer`, { approvalId, allow });
        },
        reset: async () => {
            await ensureListen();
            await invoke(`repair_reset`);
        },
    };
};
