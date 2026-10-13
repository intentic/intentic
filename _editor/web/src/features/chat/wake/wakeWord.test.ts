import { askedForNew, wakeHeard } from "./wakeWord";

// Pins what counts as being called by name: the wake word first (after a "hey" at most), however the model spelled or
// inflected it, and the request kept as the transcript wrote it; a name said in passing is talk, not a call.

describe(`wakeHeard`, () => {
    test(`the request is what follows the name, punctuation between them gone`, () => {
        expect(wakeHeard(`Leon, fix the build.`, `Leon`)).toEqual({ request: `fix the build.` });
        expect(wakeHeard(`Leon fix the build`, `Leon`)).toEqual({ request: `fix the build` });
        expect(wakeHeard(`leon: what's left?`, `Leon`)).toEqual({ request: `what's left?` });
    });

    test(`the name on its own is a call with nothing asked yet`, () => {
        expect(wakeHeard(`Leon.`, `Leon`)).toEqual({ request: `` });
        expect(wakeHeard(`Leon?`, `Leon`)).toEqual({ request: `` });
    });

    test(`the model's other spellings of the name still call it`, () => {
        for (const heard of [`Léon, napraw build`, `Leone, napraw build`, `LEON napraw build`, `Le on, napraw build`]) {
            expect(wakeHeard(heard, `Leon`)).toEqual({ request: `napraw build` });
        }
    });

    test(`an inflected name calls it (Polish says "Leonie"), a longer name does not`, () => {
        expect(wakeHeard(`Leonie, sprawdź testy`, `Leon`)).toEqual({ request: `sprawdź testy` });
        expect(wakeHeard(`Leona zapytaj`, `Leon`)).toEqual({ request: `zapytaj` });
        expect(wakeHeard(`Leonard, fix it`, `Leon`)).toBeUndefined();
        expect(wakeHeard(`Leonardo said so`, `Leon`)).toBeUndefined();
    });

    test(`one opener before the name is allowed`, () => {
        expect(wakeHeard(`Hey Leon, what changed?`, `Leon`)).toEqual({ request: `what changed?` });
        expect(wakeHeard(`Hej Leon, co się zmieniło?`, `Leon`)).toEqual({ request: `co się zmieniło?` });
        expect(wakeHeard(`OK Leon open the logs`, `Leon`)).toEqual({ request: `open the logs` });
    });

    test(`a name said in passing is not a call`, () => {
        expect(wakeHeard(`I told Leon yesterday`, `Leon`)).toBeUndefined();
        expect(wakeHeard(`Hey, so I think Leon is right`, `Leon`)).toBeUndefined();
        expect(wakeHeard(``, `Leon`)).toBeUndefined();
        // A four-letter name has too many neighbours to forgive a letter of.
        for (const near of [`Lemon tart recipe`, `Lion king`, `Neon lights`, `Lean on me`]) {
            expect(wakeHeard(near, `Leon`)).toBeUndefined();
        }
    });

    test(`a wake word of several words matches however the model joined them`, () => {
        expect(wakeHeard(`Hey Jarvis, deploy`, `Hey Jarvis`)).toEqual({ request: `deploy` });
        expect(wakeHeard(`Heyjarvis deploy`, `Hey Jarvis`)).toEqual({ request: `deploy` });
        expect(wakeHeard(`Jarvis deploy`, `Hey Jarvis`)).toBeUndefined();
    });

    test(`a short word is matched exactly, since a few letters have too many neighbours`, () => {
        expect(wakeHeard(`Max, run it`, `Max`)).toEqual({ request: `run it` });
        expect(wakeHeard(`Mac, run it`, `Max`)).toBeUndefined();
    });

    test(`a longer word forgives a letter the model got wrong`, () => {
        expect(wakeHeard(`Jarvus, deploy`, `Jarvis`)).toEqual({ request: `deploy` });
        expect(wakeHeard(`Jervus, deploy`, `Jarvis`)).toBeUndefined();
    });
});

describe(`askedForNew`, () => {
    test(`"new session" and its kin ask for a new one, and are taken off the request`, () => {
        expect(askedForNew(`new session, fix the build`)).toEqual({ request: `fix the build` });
        expect(askedForNew(`New chat: what is left`)).toEqual({ request: `what is left` });
        expect(askedForNew(`nowa sesja, sprawdź testy`)).toEqual({ request: `sprawdź testy` });
        expect(askedForNew(`nową rozmowę: napisz plan`)).toEqual({ request: `napisz plan` });
        expect(askedForNew(`neuer Chat bitte`)).toEqual({ request: `bitte` });
    });

    test(`"new" alone asks for an empty one`, () => {
        expect(askedForNew(`new`)).toEqual({ request: `` });
        expect(askedForNew(`Nowa.`)).toEqual({ request: `` });
    });

    test(`a request that only happens to say "new" is not asking for a session`, () => {
        expect(askedForNew(`new tests are failing, fix them`)).toBeUndefined();
        expect(askedForNew(`add a new session timeout`)).toBeUndefined();
        expect(askedForNew(``)).toBeUndefined();
    });
});
