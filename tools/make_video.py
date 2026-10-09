#!/usr/bin/env python3
"""Builds the demo video for Disclosure Ledger.

    python3 tools/make_video.py            # full build with narration (~4 minutes of video)
    python3 tools/make_video.py --fast     # 2s per scene, no narration (smoke test)
    python3 tools/make_video.py --scenes 4 # only the first N scenes
    python3 tools/make_video.py --keep     # keep the intermediate files

What it does
    1. serves this directory with python3 -m http.server (the app is static);
    2. drives headless Chrome over the DevTools protocol (tools/cdp.py, no
       dependencies) through each guided-tour URL (/?demo=N), waits until the step
       has finished rendering, and screenshots the page — these are real frames of
       the running product, not slides;
    3. reads the frame's scroll offset back out of the page (`data-metrics`, which
       app/main.js writes when a tour step has finished) and crops 1280x800
       around the thing that step is about;
    4. writes English narration with edge-tts (en-US-AvaNeural, rate +15%);
    5. assembles docs/media/disclosure_ledger_demo.mp4 and thumbnail.jpg with
       ffmpeg, and prints an ffprobe report.

The narration lines below were written against the app's actual behaviour, and
the recording is re-done from the live app every time, so a change in the engine
shows up in the video instead of contradicting it.
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp import Browser  # noqa: E402  (tools/cdp.py, standard library only)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"
PORT = 8789
BASE = "http://127.0.0.1:%d" % PORT
WIDTH, HEIGHT, FPS = 1280, 800, 30
TALL = 8400                    # window height for the screenshot pass
MEDIA = os.path.join(ROOT, "docs", "media")
WORK = os.path.join(MEDIA, "_work")
OUT_MP4 = os.path.join(MEDIA, "disclosure_ledger_demo.mp4")
OUT_THUMB = os.path.join(MEDIA, "thumbnail.jpg")

VOICE = "en-US-AvaNeural"
RATE = "+15%"

NARRATION = {
    0: "This is Disclosure Ledger. It checks a deliverable against the AI-disclosure rules that apply to it, "
       "drafts the statement that has to be published with it, and keeps a tamper-evident record of every step. "
       "Everything runs in this browser tab: there is no server, no account, and nothing you paste is uploaded.",
    1: "We start with a realistic document: an agency hand-over note for a campaign that shipped images, a video, "
       "a synthetic voice-over and a landing page. Paste the text, or drop a file in. We get a word count, and a "
       "SHA-256 digest of exactly what was analysed.",
    2: "Then the declaration, where honesty about scope lives: tick what the AI actually did. The app merges two "
       "sources here — what you declared, and what the text itself mentions — and every signal says which of the "
       "two turned it on.",
    3: "Now the rule packs. Four are built in: EU AI Act Article 50 transparency, the AI-use declaration public "
       "buyers ask bidders for, platform AI-labelling rules, and a competition entry declaration. Ask the app to "
       "suggest packs, and it explains why it suggested each one by naming the signals that matched.",
    4: "Run the check. Ten of the eleven applicable clauses are open, so readiness is eleven out of a hundred, and "
       "the app says that plainly, with the high-severity gaps first.",
    5: "Every gap is a card you can act on: the clause, the obligation in one line, and the wording to insert, with "
       "the place it belongs. Notice the checklist inside each card — this clause was checked, nothing was found, "
       "and it says so instead of passing quietly.",
    6: "Below the gaps is the clause-by-clause table. Satisfied clauses show the sentence that satisfied them and "
       "the exact character range, so any claim in this report can be checked against the document in one look. "
       "Clauses that do not apply say why they were skipped.",
    7: "Here is a different document: a tender response with its AI use declaration. Same engine, different packs, "
       "different gaps. The extent statement — which sections were AI-assisted — and the retention commitment are "
       "missing, and the report says so.",
    8: "The statement tab turns all of that into a draft disclosure statement: who is responsible, which tools were "
       "used, what was reviewed by a human, and the wording each pack requires. Fields left blank stay as visible "
       "placeholders and are listed at the end, so nothing is published by accident.",
    9: "Every action so far was written to this ledger. Each record carries the SHA-256 of the record before it, so "
       "the chain cannot be edited without breaking. Press verify, and every digest is recomputed from scratch: "
       "chain intact.",
    10: "Now the point of the ledger. Load a copy that was edited after the fact — a gap count quietly changed — and "
        "the verifier names the record that no longer matches. This is the same check anyone you send the file to "
        "can run in their own browser, or from the command line with the Python verifier in the repository.",
    11: "The export is one self-contained HTML file: the report, the statement and the ledger in a single page. "
        "When it is opened, the page re-verifies its own hash chain with the browser's WebCrypto and reports the "
        "verdict at the top. No server, no account, and no dependency on this app still existing.",
    12: "And the method page keeps the honest part honest: which sources the packs paraphrase, that they are not "
        "legal advice, and where your data actually lives. Disclosure Ledger: MIT licensed, standard library only, "
        "and every test runs offline.",
}


def run(cmd, **kwargs):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kwargs).stdout


def png_size(path):
    with open(path, "rb") as handle:
        head = handle.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError("%s is not a PNG" % path)
    return struct.unpack(">II", head[16:24])


def start_server():
    log = open(os.path.join(WORK, "http.log"), "w")
    proc = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
    for _ in range(40):
        try:
            with urllib.request.urlopen(BASE + "/index.html", timeout=2) as response:
                if response.status == 200:
                    return proc
        except Exception:
            time.sleep(0.25)
    proc.terminate()
    raise RuntimeError("the static server did not start on %s" % BASE)


def capture(page, url, out_png):
    """Load a tour step, wait until it has finished rendering, then crop a frame.

    The page writes `data-metrics` (with the scroll offset of the thing the step
    is about) only when the step is done, so waiting for it is what keeps blank
    frames out of the recording.
    """
    page.navigate(url)
    marker = page.wait_for("document.body.dataset.metrics || document.body.dataset.bootError || ''", timeout=60)
    if not marker:
        raise RuntimeError("the tour step never finished rendering: %s" % url)
    error = page.evaluate("document.body.dataset.bootError || ''")
    if error:
        raise RuntimeError("the app reported an error while recording %s: %s" % (url, error))
    metrics = json.loads(page.evaluate("document.body.dataset.metrics || '{}'"))
    raw = out_png.replace(".png", "_full.png")
    page.screenshot(raw)
    _, full_h = png_size(raw)
    top = int(metrics.get("pageTop", 0) or 0)
    top = max(0, min(top - 12, max(0, full_h - HEIGHT)))
    run([FFMPEG, "-y", "-loglevel", "error", "-i", raw, "-vf",
         "crop=%d:%d:0:%d" % (WIDTH, HEIGHT, top), "-frames:v", "1", out_png])
    os.remove(raw)
    # A crop that is almost pure background means the step had not painted; that
    # is worth failing on rather than shipping a white frame in the video.
    stats = run([FFPROBE, "-v", "error", "-f", "lavfi", "-i",
                 "movie=%s,signalstats" % out_png, "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
                 "-of", "default=nw=1:nk=1"]).strip()
    try:
        average = float(stats.splitlines()[0])
    except (IndexError, ValueError):
        average = 0.0
    if average > 252:
        raise RuntimeError("frame %s looks blank (average luminance %.1f)" % (out_png, average))
    return metrics


def media_duration(path):
    out = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path])
    return float(out.strip())


def narration_files(steps, work):
    """One mp3 per scene with edge-tts. Returns {step: path}, or {} if unavailable."""
    try:
        import edge_tts
    except ImportError:
        print("  edge-tts is not installed: building the video without narration")
        return {}
    out = {}
    for step in steps:
        text = NARRATION.get(step)
        if not text:
            continue
        path = os.path.join(work, "n%02d.mp3" % step)
        asyncio.run(edge_tts.Communicate(text, VOICE, rate=RATE).save(path))
        out[step] = path
        print("  narration %02d: %5.1fs" % (step, media_duration(path)))
    return out


def build_audio(scenes, work, total):
    """Place each narration clip at its scene start with adelay, then mix."""
    starts = {}
    cursor = 0.0
    for scene in scenes:
        starts[scene["step"]] = cursor
        cursor += scene["seconds"]
    clips = [scene for scene in scenes if scene.get("narr")]
    if not clips:
        return None
    cmd = [FFMPEG, "-y", "-loglevel", "error"]
    for scene in clips:
        cmd += ["-i", scene["narr"]]
    parts = []
    for index, scene in enumerate(clips):
        ms = int(starts[scene["step"]] * 1000)
        parts.append("[%d:a]adelay=%d|%d[a%d]" % (index, ms, ms, index))
    parts.append("".join("[a%d]" % i for i in range(len(clips))) +
                 "amix=inputs=%d:normalize=0:dropout_transition=0[out]" % len(clips))
    voice = os.path.join(work, "voice.m4a")
    cmd += ["-filter_complex", ";".join(parts), "-map", "[out]",
            "-c:a", "aac", "-b:a", "128k", "-t", "%.2f" % total, voice]
    run(cmd)
    return voice


def build_video(frames, scenes, work, thumbnail_png):
    segments = []
    for frame, scene in zip(frames, scenes):
        seg = os.path.join(work, "seg%02d.mp4" % scene["step"])
        run([FFMPEG, "-y", "-loglevel", "error", "-loop", "1", "-framerate", str(FPS),
             "-t", "%.3f" % scene["seconds"], "-i", frame,
             "-vf", "scale=%d:%d,format=yuv420p" % (WIDTH, HEIGHT),
             "-r", str(FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "24",
             "-pix_fmt", "yuv420p", seg])
        segments.append(seg)
    listing = os.path.join(work, "frames.txt")
    with open(listing, "w", encoding="utf-8") as handle:
        for seg in segments:
            handle.write("file '%s'\n" % seg)
    silent = os.path.join(work, "silent.mp4")
    run([FFMPEG, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listing,
         "-c", "copy", silent])
    voice = os.path.join(work, "voice.m4a")
    if os.path.exists(voice):
        run([FFMPEG, "-y", "-loglevel", "error", "-i", silent, "-i", voice,
             "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
             "-shortest", "-movflags", "+faststart", OUT_MP4])
    else:
        run([FFMPEG, "-y", "-loglevel", "error", "-i", silent, "-c:v", "copy",
             "-movflags", "+faststart", OUT_MP4])
    run([FFMPEG, "-y", "-loglevel", "error", "-i", thumbnail_png, "-vf", "scale=1280:-1",
         "-q:v", "4", OUT_THUMB])


def report():
    if not os.path.exists(FFPROBE):
        return {}
    out = run([FFPROBE, "-v", "error", "-show_entries",
               "format=duration,size:stream=codec_name,width,height,r_frame_rate",
               "-of", "json", OUT_MP4])
    return json.loads(out)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenes", type=int, default=0, help="only the first N scenes")
    parser.add_argument("--fast", action="store_true",
                        help="2 seconds per scene and no narration (quick smoke test)")
    parser.add_argument("--keep", action="store_true", help="keep the intermediate files")
    args = parser.parse_args(argv)

    for path, name in ((CHROME, "Google Chrome"), (FFMPEG, "ffmpeg"), (FFPROBE, "ffprobe")):
        if not os.path.exists(path):
            sys.stderr.write("%s was not found at %s\n" % (name, path))
            return 2

    os.makedirs(MEDIA, exist_ok=True)
    if os.path.isdir(WORK):
        shutil.rmtree(WORK)
    os.makedirs(WORK)

    steps = list(range(0, 13))
    if args.scenes:
        steps = steps[:args.scenes]

    server = start_server()
    print("serving %s at %s" % (ROOT, BASE))
    try:
        with Browser(width=WIDTH, height=2600) as browser:
            frames, scenes, thumbnail = [], [], None
            for step in steps:
                url = "%s/?demo=%d&store=localstorage" % (BASE, step)
                frame = os.path.join(WORK, "frame%02d.png" % step)
                metrics = capture(browser.new_page(), url, frame)
                print("  frame %02d pageTop=%-6s tab=%-9s gaps=%s readiness=%s" % (
                    step, metrics.get("pageTop"), metrics.get("tab"),
                    metrics.get("visible"), metrics.get("readiness")))
                frames.append(frame)
                scenes.append({"step": step, "seconds": 6.0, "narr": None})
                if thumbnail is None and step == 4:
                    thumbnail = frame
        if thumbnail is None:
            thumbnail = frames[0]

        if args.fast:
            for scene in scenes:
                scene["seconds"] = 2.0
        else:
            print("writing narration with edge-tts (%s, %s)" % (VOICE, RATE))
            vocals = narration_files([scene["step"] for scene in scenes], WORK)
            for scene in scenes:
                clip = vocals.get(scene["step"])
                if clip:
                    scene["narr"] = clip
                    scene["seconds"] = round(media_duration(clip) + 1.0, 2)
                else:
                    scene["seconds"] = 6.0
        total = sum(scene["seconds"] for scene in scenes)
        print("timeline: %d scenes, %.1fs" % (len(scenes), total))

        if not args.fast:
            build_audio(scenes, WORK, total)
        build_video(frames, scenes, WORK, thumbnail)
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except Exception:
            server.kill()


    info = report()
    size_mb = os.path.getsize(OUT_MP4) / (1024.0 * 1024.0)
    print("\nwrote %s" % OUT_MP4)
    print("  duration : %s s" % info.get("format", {}).get("duration"))
    print("  size     : %.2f MB" % size_mb)
    for stream in info.get("streams", []):
        print("  stream   : %s %sx%s %s" % (stream.get("codec_name"), stream.get("width"),
                                            stream.get("height"), stream.get("r_frame_rate")))
    print("wrote %s" % OUT_THUMB)
    if size_mb >= 25:
        print("WARNING: the file is 25MB or larger")
    if not args.keep:
        shutil.rmtree(WORK, ignore_errors=True)
    else:
        print("intermediate files kept in %s" % WORK)
    return 0


if __name__ == "__main__":
    sys.exit(main())
