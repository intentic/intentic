// Ctrl+Enter or ⌘+Enter, heard on a surface with one press for many fields (a form's Save, a draft's Create, a property's
// Done): the prompt and the rules keep Enter for their lines, so this chord is how any field sends, as in the host's own
// forms. A field that answered the chord itself has claimed it, and an input method still composing owns its Enter.
export const onSendKey =
    (send: () => void | Promise<void>) =>
    (event: KeyboardEvent): void => {
        // allow(modifier-tiers): ⌃↩ is no text chord on a Mac (isMacTextChord), and the host's forms and composer send on either.
        const chord = event.key === `Enter` && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
        if (!chord || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
            return;
        }
        event.preventDefault();
        void send();
    };
