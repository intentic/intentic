import { formatDateTime } from "@intentic/ui/format";
import { standbyNotice } from "./standbyNotice";

describe(`standbyNotice`, () => {
    it(`names the machine that runs the sandbox and since when this copy stood down`, () => {
        const since = `2026-11-11T12:00:00.000Z`;
        const line = standbyNotice({ standby: { host: `z440 (linux)`, since } });
        expect(line).toContain(`This copy is on standby: z440 (linux) runs this sandbox`);
        expect(line).toContain(formatDateTime(Date.parse(since)));
    });

    it(`says nothing on the active copy, or before the daemon has answered`, () => {
        expect(standbyNotice({})).toBeUndefined();
        expect(standbyNotice(undefined)).toBeUndefined();
    });
});
