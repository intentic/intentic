// THE SOUND'S JITTER BUFFER, RUN ON THE AUDIO THREAD. Decoded Opus arrives in packets (10-20 ms each) whenever the
// network and the decode worker let it; the audio thread asks for 128 frames every 2.7 ms at 48 kHz, on its own clock.
// The ring in between holds a small target of sound (40 ms on a steady link, more as arrivals get jittery), primes to
// it before playing, and keeps to it: a little faster or slower (±2%, resampled, inaudible) when it drifts, a jump back
// to the target when it is far behind (a stall that delivered a burst), and silence and a fresh priming when it runs
// dry. Sound that lags the picture by more than the buffer is worse than a skipped syllable.
//
// The class is shipped to the AudioWorklet as its own source text (audioWorklet.ts), so it may not reference anything
// outside itself: no imports, no module constants, no field initialisers a compiler could lower into a helper.

/** What the audio thread reports of its buffer, about twice a second. */
export interface AudioReport {
    readonly fillMs: number;
    readonly targetMs: number;
    readonly underruns: number;
    readonly drops: number;
}

export class AudioRing {
    readonly channels: number;
    readonly sampleRate: number;
    readonly capacity: number;
    readonly planes: Float32Array[];
    readIndex: number;
    count: number;
    frac: number;
    playing: boolean;
    jitterMs: number;
    lastArrival: number;
    underruns: number;
    drops: number;
    minTargetMs: number;
    maxTargetMs: number;

    constructor(channels: number, sampleRate: number) {
        this.channels = Math.max(1, Math.floor(channels));
        this.sampleRate = sampleRate;
        // A second of sound: far more than any target, so a burst after a stall is held rather than torn.
        this.capacity = Math.max(1, Math.floor(sampleRate));
        this.planes = [];
        for (let channel = 0; channel < this.channels; channel += 1) {
            this.planes.push(new Float32Array(this.capacity));
        }
        this.readIndex = 0;
        this.count = 0;
        this.frac = 0;
        this.playing = false;
        this.jitterMs = 0;
        this.lastArrival = -1;
        this.underruns = 0;
        this.drops = 0;
        this.minTargetMs = 40;
        this.maxTargetMs = 120;
    }

    // Frames for a span of ms at this rate.
    frames(ms: number): number {
        return Math.round((ms * this.sampleRate) / 1000);
    }

    fillMs(): number {
        return (this.count * 1000) / this.sampleRate;
    }

    // The buffer aimed for: the floor on a steady link, and three times the arrivals' jitter above a 20 ms base as they
    // spread, never past the ceiling.
    targetMs(): number {
        return Math.min(this.maxTargetMs, Math.max(this.minTargetMs, 20 + 3 * this.jitterMs));
    }

    // A packet of `frames` arrived at `nowSeconds` on the audio clock: how far its spacing strayed from its length feeds
    // the jitter estimate, smoothed as RTP's interarrival jitter is (1/16 per sample).
    arrived(nowSeconds: number, frames: number): void {
        if (this.lastArrival >= 0) {
            const spacingMs = (nowSeconds - this.lastArrival) * 1000;
            const lengthMs = (frames * 1000) / this.sampleRate;
            this.jitterMs += (Math.abs(spacingMs - lengthMs) - this.jitterMs) / 16;
        }
        this.lastArrival = nowSeconds;
    }

    // Appends planar samples; a channel the packet lacks repeats its first. Past capacity the oldest sound goes.
    write(planes: readonly Float32Array[]): void {
        const first = planes[0];
        if (first === undefined) {
            return;
        }
        const length = first.length;
        const overflow = this.count + length - this.capacity;
        if (overflow > 0) {
            this.skip(overflow);
        }
        const start = (this.readIndex + this.count) % this.capacity;
        for (let channel = 0; channel < this.channels; channel += 1) {
            const source = planes[channel] ?? first;
            const ring = this.planes[channel];
            if (ring === undefined) {
                continue;
            }
            const head = Math.min(length, this.capacity - start);
            ring.set(source.subarray(0, head), start);
            if (head < length) {
                ring.set(source.subarray(head, length), 0);
            }
        }
        this.count = Math.min(this.capacity, this.count + length);
    }

    skip(frames: number): void {
        const gone = Math.min(this.count, Math.max(0, Math.floor(frames)));
        this.readIndex = (this.readIndex + gone) % this.capacity;
        this.count -= gone;
    }

    // How fast this quantum plays the buffer: within 15 ms of the target as it is; outside, 2% towards it.
    ratio(): number {
        const fill = this.fillMs();
        const target = this.targetMs();
        if (fill > target + 15) {
            return 1.02;
        }
        return fill < target - 15 ? 0.98 : 1;
    }

    // Fills `out` (one array per output channel, `frames` long) from the buffer.
    read(out: readonly Float32Array[], frames: number): void {
        const silence = (): void => {
            for (const plane of out) {
                plane.fill(0, 0, frames);
            }
        };
        if (!this.playing) {
            if (this.fillMs() < this.targetMs()) {
                silence();
                return;
            }
            this.playing = true;
        }
        const behind = this.fillMs() - this.targetMs();
        if (behind > 100) {
            this.skip(this.frames(behind));
            this.frac = 0;
            this.drops += 1;
        }
        const ratio = this.ratio();
        const last = this.frac + (frames - 1) * ratio;
        // The last sample read and the one after it, which the interpolation leans on.
        if (this.count < Math.floor(last) + 2) {
            silence();
            this.playing = false;
            this.frac = 0;
            this.underruns += 1;
            return;
        }
        let position = this.frac;
        for (let at = 0; at < frames; at += 1) {
            const whole = Math.floor(position);
            const part = position - whole;
            const left = (this.readIndex + whole) % this.capacity;
            const right = (left + 1) % this.capacity;
            for (let channel = 0; channel < out.length; channel += 1) {
                const ring = this.planes[Math.min(channel, this.channels - 1)];
                const target = out[channel];
                if (ring !== undefined && target !== undefined) {
                    const from = ring[left] ?? 0;
                    target[at] = from + ((ring[right] ?? 0) - from) * part;
                }
            }
            position += ratio;
        }
        const consumed = Math.floor(position);
        this.readIndex = (this.readIndex + consumed) % this.capacity;
        this.count -= consumed;
        this.frac = position - consumed;
    }

    // Drops everything held and primes again: sound turned off, or the stream starting over.
    flush(): void {
        this.readIndex = 0;
        this.count = 0;
        this.frac = 0;
        this.playing = false;
        this.lastArrival = -1;
    }

    report(): AudioReport {
        return { fillMs: this.fillMs(), targetMs: this.targetMs(), underruns: this.underruns, drops: this.drops };
    }
}
