import { type CapabilityStatus, type LinkConfig, LinkConfigSchema, type LinkHello } from "@intentic/sandbox-contract";
import { opt } from "../../opt.js";
import { linkHello } from "../../sandboxes/link-client.js";
import type { CapabilityHandler } from "../capability.js";

/* ANOTHER OF THE OWNER'S SANDBOXES, which this one may hand tasks to (links/). The fleet's sibling for work. */

// The token is an inbound link that sandbox's owner minted for this one. Like the fleet's, it never reaches the agent's
// environment: the agent gets a tool server named after the card (links/link-mounts.ts), and the daemon presents the
// token on each call. What a task may do over there
// is that sandbox's terms, read back here only to say them.

const termsLine = (hello: LinkHello): string => {
    const wears = hello.terms.persona === undefined ? "no persona, so no signed-in account" : `the persona "${hello.terms.persona}"`;
    const waits = hello.terms.approve ? "each one waits for its owner to allow it" : "each one starts at once";
    return `Its tasks wear ${wears}; ${waits}; it takes up to ${hello.terms.turnsPerHour} turns an hour.`;
};

// The far sandbox by the name pairing gave the card, which is the one the owner knows it by; what it says of itself is
// its container's name (a daemon never learns the name the platform shows), the fallback for a card made by hand.
const nameOf = (link: LinkConfig, hello: LinkHello): string => (link.name !== undefined && link.name !== "" ? link.name : hello.sandbox);

const statusOf = (link: LinkConfig, answer: Awaited<ReturnType<typeof linkHello>>): CapabilityStatus => {
    if (answer.ok) {
        return { state: "active", detail: `${nameOf(link, answer.value)}: ${termsLine(answer.value)}` };
    }
    if (answer.status === 401) {
        return { state: "error", detail: "the other sandbox no longer holds this link: it was revoked there. Link the two again.", code: "token" };
    }
    // A sandbox that is off is not a broken link: the card stays usable and says which of the two this is.
    return { state: "pending", detail: `the other sandbox did not answer: ${answer.message}` };
};

export const linkHandler: CapabilityHandler = {
    secret: () => "token",
    echo: (config) => {
        const link = LinkConfigSchema.parse(config);
        return { url: link.url, ...opt("name", link.name), ...opt("sandboxId", link.sandboxId), hasToken: link.token !== "" };
    },
    // The id is the agent's name for the sandbox (`delegate`'s `to`); a task already handed over is followed by its
    // address too, so a rename strands nothing.
    rename: {},
    async *apply(_ctx, id, config) {
        const link = LinkConfigSchema.parse(config);
        yield { kind: "log", message: `Checking the link with ${link.url}…` };
        const hello = await linkHello({ id, config: link });
        if (!hello.ok) {
            yield { kind: "log", message: `The other sandbox did not accept it: ${hello.message}` };
            return;
        }
        yield { kind: "log", message: `Linked to "${nameOf(link, hello.value)}". ${termsLine(hello.value)}` };
        yield {
            kind: "log",
            message: `From its next turn the agent can hand it tasks with \`mcp__${id}__delegate\`. Those tasks run and land over there; only its owner changes what they may do.`,
        };
    },
    // Keeps the other sandbox's own name on the card when the form named none.
    installed: async (_ctx, id, config) => {
        const link = LinkConfigSchema.parse(config);
        if (link.name !== undefined && link.name !== "") {
            return link;
        }
        const hello = await linkHello({ id, config: link });
        return hello.ok ? { ...link, name: hello.value.sandbox } : link;
    },
    status: async (_ctx, id, config) => {
        const link = LinkConfigSchema.parse(config);
        return statusOf(link, await linkHello({ id, config: link }));
    },
    // Nothing runs here for it. The link itself stays with the other sandbox until its owner revokes it there.
    remove: async () => {},
};
