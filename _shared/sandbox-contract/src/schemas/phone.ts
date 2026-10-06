// phone: the user's own Android phone (the `phone` capability's live half)
import { z } from "zod";
import { RelayChannelSchema } from "./push.js";

// The card's switches. A phone's sibling of `device` and `webext`, not an arm of either: it has no shell and no home
// folder, and what it can be asked (its screen, the apps on it, the folders and notifications the owner handed it)
// is granted twice, once here and once on the phone itself, where Android asks the person for each kind of access.
// Every switch is enforced by the app on the phone, never checked on the daemon side. A switch the app does not know
// is read as off, so a newer sandbox never breaks an older app's connection.
const phoneScope = z.enum(["on", "off"]);
export const PhoneScopesSchema = z.object({
    // On by default, as on a computer. Android still asks the person before the first capture of a session unless the
    // touch-and-type service is on, so this switch is the sandbox's half of a consent the phone holds the other half of.
    screen: phoneScope.default("on"),
    // Tapping, swiping and typing in other apps, through the app's accessibility service. Off by default, like a
    // computer's mouse and keyboard; only the direct-download build carries it at all (Google Play forbids an agent
    // driving other apps through that service).
    control: phoneScope.default("off"),
    // Reading the folders the owner picked on the phone. Nothing else on the phone is reachable as a file.
    files: phoneScope.default("on"),
    // Creating, changing and trashing files in those folders.
    write: phoneScope.default("off"),
    // Reading the phone's notifications, which is where one-time codes and messages arrive. Off by default: it reads
    // what every other app posts.
    notifications: phoneScope.default("off"),
    // Opening apps, links and the phone's own settings screens.
    apps: phoneScope.default("on"),
    // Typing text the command classifier reads as destructive, and acting in an app the person marked sensitive.
    destructive: phoneScope.default("off"),
    // "sensitive" (default) asks on the phone before a password, payment or delete action; "always" before every
    // action; "never" trusts the owner to watch.
    confirm: z.enum(["sensitive", "always", "never"]).default("sensitive"),
});
export type PhoneScopes = z.infer<typeof PhoneScopesSchema>;
// An open slug like a device's `platform` (android today), so a new phone family needs no daemon release.
export const PhoneConfigSchema = PhoneScopesSchema.extend({ platform: z.string().min(1) });
export type PhoneConfig = z.infer<typeof PhoneConfigSchema>;

// One app the person allowed the agent into, on the phone itself: `read` lets it look, `act` lets it touch too.
// The phone's own allow-list, the way a browser's site grants are the browser's: the agent asks, only the person grants.
export const PhoneAppGrantSchema = z.object({
    package: z.string(),
    label: z.string(),
    mode: z.enum(["read", "act"]),
});
export type PhoneAppGrant = z.infer<typeof PhoneAppGrantSchema>;

// A folder the person picked on the phone, by the name the agent addresses it with.
export const PhoneFolderSchema = z.object({
    name: z.string(),
    writable: z.boolean(),
});
export type PhoneFolder = z.infer<typeof PhoneFolderSchema>;

// What a connected phone reports about itself. Strings where a newer app may say something new, so an older sandbox
// still reads it.
export const PhoneFactsSchema = z.object({
    // How a person names it: "Google Pixel 8".
    device: z.string(),
    // The Android release ("16") and its API level (36).
    android: z.string(),
    sdk: z.number().int(),
    // "direct" (downloaded from intentic.dev, can touch and type) or "play" (the store build, which cannot).
    build: z.string(),
    // The pause tile on the phone; true means every tool refuses and says the person paused it.
    paused: z.boolean(),
    // What the person has switched on in Android's own settings for this app.
    access: z.object({
        // The accessibility service behind touch and type, and behind screenshots taken without asking.
        accessibility: z.boolean(),
        // The notification listener behind reading notifications.
        notifications: z.boolean(),
        // How a screenshot is taken now: "accessibility" (no prompt), "consent" (the person allows each session) or
        // "none" (screenshots are off on the phone).
        screenCapture: z.string(),
    }),
    folders: z.array(PhoneFolderSchema),
    apps: z.array(PhoneAppGrantSchema),
    battery: z.object({ level: z.number().min(0).max(100), charging: z.boolean() }).optional(),
    // The phone's Firebase Cloud Messaging token, when Google Play services are there: what the sandbox wakes it with.
    // Not a credential (sending needs the app vendor's key), so it rides the facts.
    wake: z.object({ fcm: z.string().min(1) }).optional(),
    // Optional procedures and tool families this build answers; strings, so a newer build's never fails a read.
    features: z.array(z.string()).optional(),
});
export type PhoneFacts = z.infer<typeof PhoneFactsSchema>;

// Whether the sandbox can wake this phone when it is asleep: "ready" holds a relay channel for the phone's current
// token, "register" means the phone has a token nobody registered yet (the editor does it, signed in to the platform),
// "none" means the phone has no way to be woken (no Google Play services) and only answers while its app is open or
// set to stay connected.
export const PhoneWakeStateSchema = z.enum(["ready", "register", "none"]);
export type PhoneWakeState = z.infer<typeof PhoneWakeStateSchema>;

export const PhoneSummarySchema = z.object({
    // The capability id and the prefix of its tools (mcp__<id>__screenshot).
    id: z.string(),
    platform: z.string().min(1),
    online: z.boolean(),
    // Whether the sandbox holds a pairing for this phone. `online`, `lastSeen` and `facts` live in memory and are empty
    // after every restart, so none of them can tell a phone that was never paired from one that has not dialled in yet.
    // Absent from a daemon older than this field, which a reader takes as "cannot tell".
    paired: z.boolean().optional(),
    // The app's build; an old one reads as outdated rather than missing a tool.
    version: z.string().optional(),
    // Epoch ms of the last connection; absent after a restart rather than stale.
    lastSeen: z.number().optional(),
    facts: PhoneFactsSchema.optional(),
    wake: PhoneWakeStateSchema,
});
export type PhoneSummary = z.infer<typeof PhoneSummarySchema>;
export const PhonesListSchema = z.object({ phones: z.array(PhoneSummarySchema) });

// The editor's half of making a phone wakeable: it registered the phone's token with the platform's push relay,
// signed in as the owner, and hands the sandbox the channel the relay answered with. `token` is the one it registered,
// so a phone that rotated its token reads "register" again instead of being woken through a dead channel.
export const PhoneWakeRegistrationSchema = z.object({
    token: z.string().min(1),
    channel: RelayChannelSchema,
});
export type PhoneWakeRegistration = z.infer<typeof PhoneWakeRegistrationSchema>;
