#!/usr/bin/env python3
"""Always-on wake-word listener for Aura (Linux).

Two stages, which is the same shape Siri and Google use and the only shape that
makes an always-on microphone defensible:

  1. Wake detection runs LOCALLY and continuously, on a Vosk recogniser whose
     grammar contains exactly two entries: the wake word and "[unk]". No audio
     leaves the machine at this stage, ever.
  2. Only after the wake word fires is the following utterance recorded and
     handed to the caller, which sends that one clip to a cloud transcriber.
     The room is never uploaded; one command is.

The grammar is not an optimisation, it is what makes stage 1 work. Measured on
this machine with free (full-vocabulary) recognition, "aura open the browser"
came back as "our job and the browser" — the wake word simply is not there.
Constrained to two entries, the same audio scored a clean hit. The chosen wake
word "lurch" then scored 3/3 at confidence 1.0, with zero false positives
across every ambient sample tried, including a recording that says "aura"
repeatedly — which is the check that shows the grammar is discriminating rather
than collapsing all speech onto its single real word.

Protocol: JSON per line on stdout. Events are `ready`, `wake`, `utterance`,
`error`. stderr carries diagnostics only.
"""
import json
import os
import subprocess
import sys
import time
import wave

from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)

RATE = 16000
CHUNK = 4000                       # bytes = 2000 samples = 125 ms
WAKE_WORD = os.environ.get("AURA_WAKE_WORD", "lurch").lower()
# Conservative by default: a false wake is worse than a missed one, because it
# sends a clip of whatever was being said to a cloud transcriber.
MIN_CONF = float(os.environ.get("AURA_WAKE_CONFIDENCE", "0.7"))
# Hard cap on one command, so a stuck recogniser cannot record forever.
MAX_COMMAND_MS = int(os.environ.get("AURA_VOICE_MAX_MS", "15000"))


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def model_path():
    p = os.environ.get("AURA_VOSK_MODEL")
    if p:
        return os.path.expanduser(p)
    return os.path.expanduser("~/.aura/vosk/vosk-model-small-en-us-0.15")


class Mic:
    """arecord as a raw PCM source. Spawned here rather than piped in, so the
    listener owns its lifetime and a crash cannot leave a recorder running."""

    def __init__(self):
        args = ["arecord", "-q", "-r", str(RATE), "-f", "S16_LE", "-c", "1", "-t", "raw"]
        dev = os.environ.get("AURA_AUDIO_DEVICE")
        if dev:
            args += ["-D", dev]
        args.append("-")
        self.p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def read(self):
        return self.p.stdout.read(CHUNK)

    def close(self):
        try:
            self.p.terminate()
            self.p.wait(timeout=2)
        except Exception:
            try:
                self.p.kill()
            except Exception:
                pass


def capture_command(mic, model):
    """Record the command that follows the wake word.

    Endpointing is Vosk's, not an energy threshold. The obvious approach —
    "stop after N ms below some RMS" — cannot work in a real room: this was
    first built with an adaptive threshold measured against ambient level, and
    with a video playing on the same laptop the level never dropped below it,
    so every command ran to the 15s cap. Vosk already segments on natural
    pauses (the same audio produced two clean segments), so the recogniser that
    is about to transcribe the speech is also the best judge of when it ended.

    Returns (pcm_bytes, local_transcript). The transcript is free here, and
    good enough for short commands, so the caller can skip a cloud round trip.
    """
    rec = KaldiRecognizer(model, RATE)
    frames = []
    text = []
    started = time.time()
    while True:
        buf = mic.read()
        if not buf:
            break
        frames.append(buf)
        if rec.AcceptWaveform(buf):
            said = json.loads(rec.Result()).get("text", "").strip()
            if said:
                text.append(said)
                break                     # a complete utterance, ended by a pause
        if (time.time() - started) * 1000 > MAX_COMMAND_MS:
            said = json.loads(rec.FinalResult()).get("text", "").strip()
            if said:
                text.append(said)
            break
    return b"".join(frames), " ".join(text).strip()


def write_wav(path, pcm):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)


def main():
    mp = model_path()
    if not os.path.isdir(mp):
        emit({"event": "error", "error": f"Vosk model not found at {mp}. "
              f"Download vosk-model-small-en-us-0.15 or set AURA_VOSK_MODEL."})
        return 1

    model = Model(mp)
    # Two entries only: the wake word, and a catch-all for everything else.
    grammar = json.dumps([WAKE_WORD, "[unk]"])
    rec = KaldiRecognizer(model, RATE, grammar)
    rec.SetWords(True)

    mic = Mic()
    emit({"event": "ready", "wake_word": WAKE_WORD, "confidence": MIN_CONF})

    try:
        while True:
            buf = mic.read()
            if not buf:
                emit({"event": "error", "error": "microphone stream ended"})
                break

            if not rec.AcceptWaveform(buf):
                continue
            result = json.loads(rec.Result())

            hit = None
            for w in result.get("result", []):
                if w.get("word") == WAKE_WORD and float(w.get("conf", 0)) >= MIN_CONF:
                    hit = float(w["conf"])
                    break
            if hit is None:
                continue

            emit({"event": "wake", "confidence": round(hit, 3)})
            pcm, heard = capture_command(mic, model)
            ms = int(len(pcm) / 2 / RATE * 1000)
            if not heard:
                # The wake word with nothing after it. Reported rather than
                # uploaded: the user most likely just said the name.
                emit({"event": "utterance", "path": None, "text": "", "ms": ms, "empty": True})
            else:
                path = os.path.join("/tmp", f"aura-voice-{int(time.time()*1000)}.wav")
                write_wav(path, pcm)
                emit({"event": "utterance", "path": path, "text": heard,
                      "ms": ms, "empty": False})

            # A fresh recogniser after each command: the old one still holds the
            # tail of the command audio, and that tail can re-trigger the wake
            # word on the next frame.
            rec = KaldiRecognizer(model, RATE, grammar)
            rec.SetWords(True)
    except KeyboardInterrupt:
        pass
    finally:
        mic.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
