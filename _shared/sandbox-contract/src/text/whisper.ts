/* WHAT WHISPER.CPP'S STDOUT MEANS, agreed between the two places that run it: the daemon's speech route (a
 * composer utterance dictated into the box) and the Discord connector's voice session (a caller's utterance in
 * a live call). Two integrations, one binary, one output format — so the reading of it is stated once. When
 * whisper changes how it renders non-speech, there is one filter to correct rather than two that disagree
 * until somebody notices the connector transcribing `[BLANK_AUDIO]` as if a caller had said it. */

// The Hugging Face repo the `ggml-*.bin` weights are pulled from on first use. Both integrations download
// their own model (different sizes, different trade-offs) but from the same publisher.
export const WHISPER_MODEL_REPO = "ggerganov/whisper.cpp";

/* Whisper's stdout for one utterance → clean single-line text, or undefined for silence/noise-only output.
 * Whisper renders non-speech as bracketed annotations (`[BLANK_AUDIO]`, `(wind blowing)`), and a line that is
 * ENTIRELY one of those is an observation about the audio rather than something anybody said: dropping it is
 * what keeps a pause out of a transcript and stops a silent utterance from dispatching an empty turn. */
export const cleanTranscription = (stdout: string): string | undefined => {
    const text = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !/^[[(].*[\])]$/.test(line))
        .join(" ")
        .trim();
    return text === "" ? undefined : text;
};
