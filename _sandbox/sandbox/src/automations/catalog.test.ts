import { CORE_TRIGGER_SOURCES, S2S_PROVIDER } from "./catalog.js";

// (2026-11-26) The daemon declares only the sources whose events it emits itself; every template, and every source
// anyone on the internet reaches through a page (bug reports, the Visitor chat), is an extension's, offered while it is
// on. (2026-11-27) What other sandboxes send this one is the daemon's own (`s2s`), and a stranger reaches it only with a
// contact request.

test(`the daemon's own sources are the ones it emits, and only s2s is reached by strangers`, () => {
    expect(CORE_TRIGGER_SOURCES.map((source) => source.provider)).toEqual([`ci`, `s2s`]);
    expect(CORE_TRIGGER_SOURCES.filter((source) => source.strangers !== undefined).map((source) => [source.provider, source.strangers])).toEqual([
        [`s2s`, `contact`],
    ]);
});

test(`s2s offers its four events by the wire's own names, narrowed by contact and scope, with the contact as its sender`, () => {
    expect(CORE_TRIGGER_SOURCES.find((source) => source.provider === S2S_PROVIDER)).toEqual({
        provider: `s2s`,
        label: `Messages from sandboxes`,
        icon: `envelope`,
        requires: [],
        enabled: true,
        strangers: `contact`,
        events: [
            { value: `message`, label: `Message` },
            { value: `report`, label: `Problem report` },
            { value: `contact.request`, label: `Contact request` },
            { value: `task.request`, label: `Task request` },
        ],
        channel: {
            label: `Contact (optional)`,
            placeholder: `every contact`,
            hint: `The contact's address, as its row on the Messages tab shows it.`,
        },
        branchField: {
            label: `Scope (optional)`,
            placeholder: `every scope`,
            hint: "`sandbox` for the sandbox speaking as itself, or a person's email for their own route",
        },
        sender: { label: `Contact address`, placeholder: `ops.acme.example` },
        starterPrompt: expect.stringContaining(
            'Read the whole thread with `messages show <thread>`, reply with `messages send <contact> --thread <thread> --text "…"`, and take ' +
                "attached files into a folder with `messages take <message> <folder>`. A contact request is answered by a person: " +
                "`messages contacts accept <id>` raises their card",
        ),
    });
});
