import "@intentic/testing/dom";
import { type App, createApp, h } from "vue";
import { IconStub } from "@intentic/ui/testing";
import { NO_ATTENTION } from "../../../../models/agent-status/agentStatus-lanes";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import AgentLandFailure from "./AgentLandFailure.vue";

let app: App | undefined;
let mountedElement: HTMLElement | undefined;
const mount = (reason: string, canShip = true, canChat = true) => {
    const agent: FleetAgent = {
        id: `agent-1`, provider: `claude`, harness: `native`, status: `error`, updatedAt: 1,
        attention: NO_ATTENTION, branch: `agent/work`, landFailure: { reason, at: 1 },
        open: false, unread: false, unsent: false,
    };
    const retry = jest.fn();
    const chat = jest.fn();
    const element = document.createElement(`div`);
    mountedElement = element;
    app = createApp({ render: () => h(AgentLandFailure, { agent, canShip, canChat, busy: false, onRetry: retry, onChat: chat }) });
    app.component(`Icon`, IconStub);
    app.mount(element);
    return { element, retry, chat };
};

afterEach(() => {
    app?.unmount();
    mountedElement?.remove();
});

test(`a failed land keeps its original Git details available and offers a way back to chat`, () => {
    const reason = `Command failed: git apply --check /tmp/work.patch\n`;
    const { element, chat } = mount(reason);
    expect(element.querySelector(`[role="status"]`)?.textContent).toBe(`Couldn't land: git refused to carry its work into your files`);
    expect(element.textContent).toContain(`Your changes are still on agent/work.`);
    expect(element.querySelector(`details`)?.open).toBe(false);
    expect(element.querySelector(`details pre`)?.textContent).toBe(reason);
    const buttons = [...element.querySelectorAll(`button`)];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([`Open chat`, `Copy`]);
    buttons[0]!.click();
    expect(chat).toHaveBeenCalledTimes(1);
});

test(`retry remains available for a stopped Git process and respects shipping permission`, () => {
    const { element, retry } = mount(`the forker exited`, true, false);
    const button = element.querySelector(`button`)!;
    expect(button.textContent?.trim()).toBe(`Retry`);
    button.click();
    expect(retry).toHaveBeenCalledTimes(1);

    app?.unmount();
    const readOnly = mount(`the forker exited`, false, false);
    expect([...readOnly.element.querySelectorAll(`button`)].map((item) => item.textContent?.trim())).toEqual([`Copy`]);
});
