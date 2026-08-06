import os
import sys

from faster_whisper import WhisperModel

model = os.environ.get("STT_WHISPER_MODEL", "small")
whisper = WhisperModel(model, device="cpu", compute_type="int8")
segments, _ = whisper.transcribe(sys.argv[1], language="zh")
print("".join(s.text for s in segments).strip(), end="")
