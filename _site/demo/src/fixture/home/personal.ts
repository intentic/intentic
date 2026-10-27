import { act, ask, closing, type HomeStory, opening, say, text } from "./story";

// THE PERSONAL SANDBOX'S HOME: the owner asks for train tickets to a family birthday, and the agent checks the calendar,
// finds the trains, asks before it spends anything, books, puts them in the calendar and sends them on.

export const PERSONAL: HomeStory = {
    history: [
        { role: `user`, text: `What's on this weekend?` },
        {
            role: `assistant`,
            text: `Saturday is **Mum's 60th in Kraków**, lunch at 13:00. Nothing else is planned, and you and Tom don't have train tickets yet.`,
        },
    ],
    prompt: `Book trains for me and Tom: Friday evening there, back Sunday afternoon. Window seats if you can.`,
    beats: [
        opening(),
        ...say(1_800, `Checking your calendar first, then the trains.`),
        ...act(400, {
            id: `tc_personal_calendar`,
            name: `Calendar`,
            category: `read`,
            target: `Friday to Sunday`,
            takes: 900,
            result: text(`Friday: free from 16:00 · Saturday: lunch at 13:00 · Sunday: free after 12:00`),
        }),
        ...act(400, {
            id: `tc_personal_there`,
            name: `Browser navigate`,
            category: `fetch`,
            target: `intercity.pl · Warszawa → Kraków, Friday after 16:30`,
            takes: 1_500,
            result: text(`5 trains · the 17:10 has two window seats together`),
        }),
        ...act(300, {
            id: `tc_personal_back`,
            name: `Browser navigate`,
            category: `fetch`,
            target: `intercity.pl · Kraków → Warszawa, Sunday after 14:00`,
            takes: 1_300,
            result: text(`4 trains · the 15:05 has two window seats together`),
        }),
        ...say(
            500,
            `The **17:10 on Friday** gets you to Kraków at 19:32, and the **15:05 on Sunday** has you home by 17:27. Both have two window seats side by side.`,
        ),
        ask(400, `ask_personal_pay`, `Payment`, `Book all four tickets for €96 with your Visa ending 4421?`, [
            { label: `Book them (Recommended)`, description: `Seats 41 and 42 by the window, both ways.` },
            {
                label: `Find something cheaper`,
                description: `Slower trains from €68, with a change in Katowice.`,
                onPick: [
                    ...act(500, {
                        id: `tc_personal_cheaper`,
                        name: `Browser navigate`,
                        category: `fetch`,
                        target: `intercity.pl · cheapest fares, Friday and Sunday`,
                        takes: 1_400,
                        result: text(`€68 for four · Friday 16:40 and Sunday 14:20, both with a change in Katowice`),
                    }),
                    ...say(
                        500,
                        `The cheapest is **€68 for all four**: Friday at 16:40, in Kraków at 20:05, and Sunday at 14:20, home at 17:50. Both change in Katowice, and the seats aren't together.\n\nNothing is booked yet. Say the word and I'll book these instead.`,
                    ),
                    ...closing({ kind: `usage`, account: `ada@acme.dev`, costUsd: 0.27, inputTokens: 24_600, outputTokens: 2_000 }),
                ],
            },
        ]),
        ...act(500, {
            id: `tc_personal_book`,
            name: `Browser click`,
            category: `other`,
            target: `Pay €96.00`,
            takes: 1_700,
            result: text(`Booked · reference IC-48213 · 4 tickets sent to your email`),
        }),
        ...act(300, {
            id: `tc_personal_add`,
            name: `Calendar`,
            category: `edit`,
            target: `Add both trains, with the seats`,
            takes: 800,
            result: text(`Friday 17:10–19:32 and Sunday 15:05–17:27 added`),
        }),
        ...act(300, {
            id: `tc_personal_tom`,
            name: `WhatsApp`,
            category: `other`,
            target: `Send Tom the tickets`,
            takes: 1_100,
            result: text(`Delivered. Tom: "Perfect, see you at the station."`),
        }),
        ...say(
            500,
            `**You're both booked.**\n\n- **Friday** 17:10 from Warszawa Centralna, in Kraków at 19:32\n- **Sunday** 15:05 from Kraków Główny, home at 17:27\n\nWindow seats 41 and 42 both ways, €96 in total. The trains are in your calendar, and Tom has the tickets on WhatsApp.`,
        ),
        ...closing({ kind: `usage`, account: `ada@acme.dev`, costUsd: 0.31, inputTokens: 27_900, outputTokens: 2_300 }),
    ],
};
