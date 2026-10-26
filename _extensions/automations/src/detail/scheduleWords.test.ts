import { ZoneSchema } from "@intentic/sandbox-contract/time";
import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages } from "../i18n";
import { manifest } from "../manifest";
import { scheduleSentence } from "./scheduleWords";

await registerExtensionMessages(extensionIdOf(manifest), messages);

const UTC = ZoneSchema.parse(`UTC`);
const WARSAW = ZoneSchema.parse(`Europe/Warsaw`);
const said = (cron: string): string | undefined => scheduleSentence(cron, UTC, UTC);

test(`repeating rules say how often and at which minute, and a window says when it starts and stops`, () => {
    expect(said(`*/10 * * * *`)).toBe(`Every 10 minutes`);
    expect(said(`37 * * * *`)).toBe(`Every hour at :37`);
    expect(said(`47 */2 * * *`)).toBe(`Every 2 hours at :47`);
    expect(said(`7 9-22 * * *`)).toBe(`Every hour from 09:07 to 22:07`);
    // A stepped window stops at the last hour it actually fires in.
    expect(said(`0 8-20/3 * * *`)).toBe(`Every 3 hours from 08:00 to 20:00`);
    expect(said(`0 9-22/4 * * *`)).toBe(`Every 4 hours from 09:00 to 21:00`);
    expect(said(`11 9-22 * * 1,3,4`)).toBe(`Every hour from 09:11 to 22:11, on Mon, Wed and Thu`);
    expect(said(`0 */2 * * 1-5`)).toBe(`Every 2 hours at :00, weekdays`);
});

test(`fixed times say the days they fall on, Monday first, with several times listed`, () => {
    expect(said(`0 5 * * *`)).toBe(`Every day at 05:00`);
    expect(said(`30 17 * * 1-5`)).toBe(`Weekdays at 17:30`);
    expect(said(`0 10 * * 0,6`)).toBe(`Weekends at 10:00`);
    expect(said(`7 10 * * 3`)).toBe(`Every Wed at 10:07`);
    expect(said(`7 11 * * 5,2`)).toBe(`Every Tue and Fri at 11:07`);
    expect(said(`7 7 * * 0`)).toBe(`Every Sun at 07:07`);
    expect(said(`0 9,14 * * 1-5`)).toBe(`Weekdays at 09:00 and 14:00`);
    expect(said(`0 9 1 * *`)).toBe(`Monthly on the 1st at 09:00`);
});

test(`the clock is named only for a reader on another one, and only where the sentence names a time`, () => {
    expect(scheduleSentence(`0 5 * * *`, WARSAW, UTC)).toBe(`Every day at 05:00 UTC`);
    expect(scheduleSentence(`7 9-22 * * *`, WARSAW, UTC)).toBe(`Every hour from 09:07 to 22:07 UTC`);
    expect(scheduleSentence(`47 */2 * * *`, WARSAW, UTC)).toBe(`Every 2 hours at :47`);
    expect(scheduleSentence(`*/5 * * * *`, WARSAW, UTC)).toBe(`Every 5 minutes`);
});

test(`a shape it has no words for is left to the caller, never guessed`, () => {
    expect(said(`0 0 L * *`)).toBeUndefined();
    expect(said(`0 9 * 1 *`)).toBeUndefined();
    expect(said(`0 9 1 * 1`)).toBeUndefined();
    expect(said(`*/5 9 * * *`)).toBeUndefined();
    expect(said(`0 9 * *`)).toBeUndefined();
    expect(said(`61 9 * * *`)).toBeUndefined();
});
