import { activeSandboxId } from "../../../_editor/web/src/features/sandbox/overview/activeSandbox.ts";
import { claimFloating, floatingOwner } from "../../../_editor/web/src/shell/window/floating.ts";
import { drawsChat, elsewhereStrip, publishStrip } from "../../../_editor/web/src/features/chat/run/chatEcho.ts";
import { EMPTY_STRIP } from "../../../_editor/web/src/features/chat/tabs/tabFacts.ts";

activeSandboxId.value = `sb1`;
const owner = floatingOwner(`chat`);
const holder = new URL(location.href).searchParams.has(`holder`);
if (holder) {
    publishStrip(JSON.parse(sessionStorage.getItem(`fixture-strip`) ?? JSON.stringify(EMPTY_STRIP)), `sb1`);
    claimFloating(`chat`, () => location.assign(`about:blank`));
}

window.chatWindow = {
    draws: () => drawsChat.value,
    owner: () => owner.value,
    state: () => elsewhereStrip.value,
    select: (sandbox) => {
        activeSandboxId.value = sandbox;
    },
    publish: (id) => {
        const strip = {
            active: id,
            panes: [id],
            tabs: [
                {
                    id,
                    registered: false,
                    standing: `draft`,
                    provider: `claude`,
                    harness: `native`,
                    peek: false,
                    standIn: false,
                    model: ``,
                    unsent: true,
                    preview: id,
                },
            ],
            run: { runId: `run-${id}`, mode: `pinned` },
        };
        sessionStorage.setItem(`fixture-strip`, JSON.stringify(strip));
        publishStrip(strip, activeSandboxId.value);
    },
};
