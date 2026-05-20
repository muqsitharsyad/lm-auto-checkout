#!/usr/bin/env python3
"""
Local reCAPTCHA audio challenge solver using free Google Speech Recognition.

Usage:
    python solve-captcha.py <audio_url>

Outputs:
    On success: prints the transcript to stdout (just the text, nothing else).
    On failure: exits with non-zero code, error message on stderr.

Dependencies:
    pip install SpeechRecognition pydub requests
    System: ffmpeg must be installed and on PATH

Why local STT:
    Google's Web Speech API used by `recognize_google()` is free and requires
    no API key. Wit.ai (the previous approach) gets blocked by Google's reCAPTCHA
    flagging. Running locally with the audio downloaded directly avoids that.
"""

from __future__ import annotations

import sys
import tempfile
import os
from pathlib import Path


def solve(audio_url: str) -> str:
    """Download MP3 audio challenge, convert to WAV, transcribe via Google STT."""
    import requests
    from pydub import AudioSegment
    import speech_recognition as sr

    with tempfile.TemporaryDirectory() as tmpdir:
        mp3_path = Path(tmpdir) / "challenge.mp3"
        wav_path = Path(tmpdir) / "challenge.wav"

        # Download audio
        resp = requests.get(audio_url, timeout=30)
        resp.raise_for_status()
        mp3_path.write_bytes(resp.content)

        # Convert MP3 → WAV (16kHz mono is best for STT)
        audio = AudioSegment.from_mp3(mp3_path)
        audio = audio.set_frame_rate(16000).set_channels(1)
        audio.export(wav_path, format="wav")

        # Transcribe
        recognizer = sr.Recognizer()
        with sr.AudioFile(str(wav_path)) as source:
            audio_data = recognizer.record(source)

        # recognize_google uses the free public Web Speech API (no key)
        text: str = recognizer.recognize_google(audio_data, language="en-US")
        return text.strip()


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: solve-captcha.py <audio_url>", file=sys.stderr)
        return 2

    audio_url = sys.argv[1]
    try:
        transcript = solve(audio_url)
        if not transcript:
            print("Empty transcript", file=sys.stderr)
            return 1
        # Stdout is consumed by the Node.js parent — print only the transcript
        print(transcript)
        return 0
    except Exception as e:
        print(f"Captcha solve failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
