// Through the door the viewer imports it by: the clock itself lives in the kit, since the chat composer's audio chip
// draws the same one and two players disagreeing about "0:59" is the bug this shares to avoid.
import { formatDuration } from "@intentic/extension-ui/format";
import { playableSource, renditionReady, seekTargets, SPEEDS } from "./mediaControls";

describe(`formatDuration`, () => {
    it(`drops the hours field below an hour`, () => {
        expect(formatDuration(0)).toBe(`0:00`);
        expect(formatDuration(9)).toBe(`0:09`);
        expect(formatDuration(95)).toBe(`1:35`);
        expect(formatDuration(3599)).toBe(`59:59`);
    });

    it(`adds hours once there are any, and pads the fields under them`, () => {
        expect(formatDuration(3600)).toBe(`1:00:00`);
        expect(formatDuration(3661)).toBe(`1:01:01`);
        expect(formatDuration(36061)).toBe(`10:01:01`);
    });

    it(`truncates rather than rounds, so the clock never shows a second the file hasn't reached`, () => {
        expect(formatDuration(59.9)).toBe(`0:59`);
    });

    /* A container that never declared its duration (a .webm with no cues) reads back Infinity, and a media element reports NaN before metadata lands. */
    it(`shows a dash for a duration the container never declared`, () => {
        expect(formatDuration(Number.POSITIVE_INFINITY)).toBe(`--:--`);
        expect(formatDuration(Number.NaN)).toBe(`--:--`);
        expect(formatDuration(-1)).toBe(`--:--`);
    });
});

describe(`the transport's shared tables`, () => {
    it(`pairs every seek key with its opposite`, () => {
        expect(seekTargets[`ArrowLeft`]).toBe(-seekTargets[`ArrowRight`]!);
        expect(seekTargets[`j`]).toBe(-seekTargets[`l`]!);
        // Shift-held variants resolve the same way rather than falling through to nothing.
        expect(seekTargets[`J`]).toBe(seekTargets[`j`]);
        expect(seekTargets[`L`]).toBe(seekTargets[`l`]);
    });

    // The `,`/`.` shortcuts step through this array by index, so an unsorted or duplicated ladder would make
    // "one step slower" jump or stall.
    it(`keeps the speed ladder sorted, unique, and centred on 1×`, () => {
        expect(SPEEDS).toEqual(SPEEDS.toSorted((a, b) => a - b));
        expect(new Set(SPEEDS).size).toBe(SPEEDS.length);
        expect(SPEEDS).toContain(1);
    });
});

// A recording the browser can't decode (AIFF, CAF, WMA, an ADPCM WAV) is asked for once more, as the daemon's AAC rendering.
describe(`playableSource`, () => {
    it(`asks a streamed address for its rendition, once`, () => {
        const src = `https://box.example/workspace/media?path=take.aiff&ticket=t1`;
        expect(playableSource(src)).toBe(`${src}&playable=1`);
        expect(playableSource(`${src}&playable=1`)).toBeUndefined();
    });

    it(`has nothing to ask of bytes the page already holds`, () => {
        expect(playableSource(`blob:https://box.example/5c1e`)).toBeUndefined();
    });
});

/* A video the browser can't decode takes minutes to re-encode, longer than a proxy holds one request: the daemon answers
   503 with Retry-After while it works, and the player asks again rather than handing the element an address that fails. */
describe(`waiting for the daemon's rendition`, () => {
    const answer = (status: number, headers: Record<string, string> = {}): Response => new Response(status === 503 ? `{}` : `x`, { status, headers });
    const scripted = (statuses: readonly Response[]) => {
        const asked: RequestInit[] = [];
        const slept: number[] = [];
        let next = 0;
        return {
            asked,
            slept,
            ask: async (_url: string, init: RequestInit) => {
                asked.push(init);
                return statuses[next++] ?? answer(500);
            },
            pause: async (ms: number) => {
                slept.push(ms);
            },
        };
    };

    it(`asks again while it is being made, after the pause the daemon names, until it streams`, async () => {
        const wire = scripted([answer(503, { "retry-after": `3` }), answer(503), answer(206)]);
        expect(await renditionReady(`/workspace/media?path=a.avi&playable=1`, new AbortController().signal, wire)).toBe(true);
        expect(wire.asked).toHaveLength(3);
        expect(wire.slept).toEqual([3000, 2000]);
        // One byte, so confirming a finished rendition moves nothing.
        expect(wire.asked[0]?.headers).toEqual({ Range: `bytes=0-0` });
    });

    it(`gives up on what can't be made, and on a network that fails`, async () => {
        expect(await renditionReady(`u`, new AbortController().signal, scripted([answer(415)]))).toBe(false);
        const down = { ask: async () => { throw new TypeError(`Failed to fetch`); }, pause: async () => {} };
        expect(await renditionReady(`u`, new AbortController().signal, down)).toBe(false);
    });

    it(`stops asking once the player moves on`, async () => {
        const moved = new AbortController();
        const wire = scripted([answer(503), answer(503), answer(206)]);
        const ready = renditionReady(`u`, moved.signal, {
            ask: wire.ask,
            pause: async () => {
                moved.abort();
            },
        });
        expect(await ready).toBe(false);
        expect(wire.asked).toHaveLength(1);
    });
});
