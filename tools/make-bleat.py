#!/usr/bin/env python3
"""Synthesise the sheep bleat the app plays when an agent finishes.

Committing a .wav with no source leaves a sound nobody can tune, so the file is
generated: run `python3 tools/make-bleat.py` to rewrite web/bleat.wav.

A bleat is a buzzy glottal source under an open vowel, flattened by the fast
tremolo that makes it read as a sheep rather than a synth tone. Three formant
resonators shape /ae/ ("maeae"), the first of them swept down from a closed,
nasal onset so the sound opens into the vowel the way "m-aeae" does.
"""

import math
import struct
import wave
from pathlib import Path

RATE = 22050
DUR = 0.85
OUT = Path(__file__).resolve().parent.parent / "web" / "bleat.wav"

# /ae/ as in "baa": F1 low and open, F2 high and bright, F3 for presence. The
# upper two are lifted hard because a glottal source rolls off at -6dB/octave,
# and without that lift the vowel comes out closer to "moo" than "maeae".
FORMANTS = [(720, 90, 1.0), (1650, 120, 2.6), (2500, 170, 2.2)]
NASAL_F1 = 320          # the "m": mouth closed, first formant way down
BLEAT_HZ = 26.0         # tremolo rate - the flutter that says sheep
PITCH_START = 300.0
PITCH_END = 218.0


def resonator(sig, freq_at, bw, gain):
    """Two-pole bandpass swept per sample, so a formant can glide."""
    out = [0.0] * len(sig)
    y1 = y2 = 0.0
    for i, x in enumerate(sig):
        r = math.exp(-math.pi * bw / RATE)
        theta = 2 * math.pi * freq_at(i) / RATE
        a1 = 2 * r * math.cos(theta)
        a2 = -(r * r)
        y = (1 - r) * x + a1 * y1 + a2 * y2
        y2, y1 = y1, y
        out[i] = y * gain
    return out


def main():
    n = int(RATE * DUR)

    # Glottal source: a band-limited sawtooth, falling in pitch like a real
    # bleat trailing off, with the tremolo also wobbling the pitch slightly.
    phase = 0.0
    source = [0.0] * n
    for i in range(n):
        t = i / RATE
        frac = i / n
        f0 = PITCH_START + (PITCH_END - PITCH_START) * frac
        f0 *= 1.0 + 0.045 * math.sin(2 * math.pi * BLEAT_HZ * t)
        phase += f0 / RATE
        phase -= math.floor(phase)
        # Sawtooth via a few harmonics: cheap, and no aliasing hash.
        s = 0.0
        for h in range(1, 40):
            if f0 * h > RATE / 2.2:
                break
            s += math.sin(2 * math.pi * h * phase) / h
        source[i] = s * 0.5

    # The "m" closes the first formant for the first ~90ms, then it opens.
    def f1_at(i):
        open_by = 0.09 * RATE
        if i >= open_by:
            return FORMANTS[0][0]
        k = i / open_by
        return NASAL_F1 + (FORMANTS[0][0] - NASAL_F1) * (k * k)

    voiced = resonator(source, f1_at, FORMANTS[0][1], FORMANTS[0][2])
    for freq, bw, gain in FORMANTS[1:]:
        # The nasal onset is dark: hold back the upper formants until it opens.
        band = resonator(source, lambda i, f=freq: f, bw, gain)
        for i in range(n):
            voiced[i] += band[i] * min(1.0, max(0.0, (i / RATE - 0.05) / 0.06))

    # Envelope: quick attack, tremolo body, gentle release.
    out = [0.0] * n
    for i in range(n):
        t = i / RATE
        attack = min(1.0, t / 0.035)
        release = min(1.0, (DUR - t) / 0.18)
        trem = 0.72 + 0.28 * math.sin(2 * math.pi * BLEAT_HZ * t - math.pi / 2)
        out[i] = voiced[i] * attack * release * trem

    peak = max(abs(v) for v in out) or 1.0
    frames = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, v / peak * 0.89)) * 32767))
                      for v in out)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)
    print(f"wrote {OUT} ({len(frames) + 44} bytes, {DUR:.2f}s)")


if __name__ == "__main__":
    main()
