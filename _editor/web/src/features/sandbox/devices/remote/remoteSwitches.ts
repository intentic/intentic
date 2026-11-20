import type { AddCapabilityInput } from "@intentic/capability-catalog";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";

// A computer's switches for people's remote access, as its capability card keeps them (DeviceScopesSchema's
// `remoteView`, `remoteControl`, `remoteTerminal`: "on" or "off", off unless switched on), and the card's settings with
// one of them changed, as the card's own form would save them: every other setting as it is, written as text.

export const REMOTE_SWITCHES = [`remoteView`, `remoteControl`, `remoteTerminal`] as const;
export type RemoteSwitch = (typeof REMOTE_SWITCHES)[number];

/** Whether the card has this switch on; a card from before the switches existed has them off. */
export const switchedOn = (config: CapabilitySummary[`config`], key: RemoteSwitch): boolean => config[key] === `on`;

/** The card's settings with `key` switched, every value as the text the form writes. */
export const configWith = (config: CapabilitySummary[`config`], key: RemoteSwitch, on: boolean): AddCapabilityInput[`config`] => ({
    ...Object.fromEntries(Object.entries(config).map(([name, value]) => [name, String(value)])),
    [key]: on ? `on` : `off`,
});
