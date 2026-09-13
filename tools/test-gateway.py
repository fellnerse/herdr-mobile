#!/usr/bin/env python3
"""Gateway tests: python3 tools/test-gateway.py

Three things here have no forgiveness in them:

* the bincode codec, where a varint boundary off by one desynchronises every
  frame after it,
* the WebSocket framing, where a mask applied wrong turns keystrokes into
  noise the terminal then executes,
* the git reading, where a path with a space in it used to be two paths.

The git tests build a real repository in a temporary directory rather than
faking git's output, because the output is what is being tested.

Standard library only, like everything else here.
"""

import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gateway"))

import bincode  # noqa: E402
import gitdiff  # noqa: E402
import terminal  # noqa: E402
import wsproto  # noqa: E402

failures = []


def check(name, actual, expected):
    if actual != expected:
        failures.append(f"FAIL {name}\n  expected {expected!r}\n  actual   {actual!r}")


# -- bincode ----------------------------------------------------------------

def roundtrip(value):
    w = bincode.BinWriter()
    w.varint(value)
    return bincode.BinReader(w.to_bytes()).varint()


# The markers sit exactly on these boundaries, and every one of them is a
# different number of bytes on the wire.
for value in (0, 1, 250, 251, 252, 0xFFFF, 0x10000, 0xFFFFFFFF, 0x100000000):
    check(f"varint {value}", roundtrip(value), value)

def varint_bytes(value):
    w = bincode.BinWriter()
    w.varint(value)
    return w.to_bytes()


# The marker byte is what says how many follow it.
check("250 is one byte", varint_bytes(250), b"\xfa")
check("251 takes a u16", varint_bytes(251), b"\xfb\xfb\x00")
check("65536 takes a u32", varint_bytes(65536), b"\xfc\x00\x00\x01\x00")
check("2^32 takes a u64", len(varint_bytes(0x100000000)), 9)

w = bincode.BinWriter()
w.string("term_65b07ee9b73a41")
w.bool(True)
w.bytes(b"\x1b[A")
w.option(None, lambda v: w.varint(v))
w.option(7, lambda v: w.varint(v))
r = bincode.BinReader(w.to_bytes())
check("string", r.string(), "term_65b07ee9b73a41")
check("bool", r.bool(), True)
check("bytes", r.bytes(), b"\x1b[A")
check("option none", r.option(r.varint), None)
check("option some", r.option(r.varint), 7)
check("nothing left over", r.remaining, 0)

# Non-ASCII has to survive: pane titles carry branch glyphs and emoji.
w = bincode.BinWriter()
w.string("~/r/herdr-mobile  feat/sheep-it ❄️")
check("utf-8 string", bincode.BinReader(w.to_bytes()).string(),
      "~/r/herdr-mobile  feat/sheep-it ❄️")

frame = bincode.encode_frame(b"hello")
check("frame is length-prefixed", frame, struct.pack("<I", 5) + b"hello")

# A short read is an error, not a silent zero.
try:
    bincode.BinReader(b"\xfb\x01").varint()
    failures.append("FAIL short read should raise")
except ValueError:
    pass

# -- the Herdr handshake ----------------------------------------------------

class FakeUnix:
    """Stands in for the client socket: keeps what the stream sends."""

    def __init__(self):
        self.sent = b""

    def sendall(self, data):
        self.sent += data

    def settimeout(self, value):
        pass

    def shutdown(self, how):
        pass

    def close(self):
        pass


def sent_frames(stream):
    """Every frame written so far, length prefix stripped."""
    buf = stream._sock.sent
    frames = []
    while len(buf) >= 4:
        (length,) = struct.unpack("<I", buf[:4])
        frames.append(buf[4:4 + length])
        buf = buf[4 + length:]
    return frames


def stream_for(protocol):
    stream = terminal.TerminalStream("/dev/null", protocol, on_data=lambda d: None)
    stream._sock = FakeUnix()
    return stream


# Protocol 22 opens with TerminalHello: no encoding, no keybindings, no launch
# mode, and a pixel_mouse flag where they used to be.
stream = stream_for(22)
stream._send_hello(80, 24)
check("terminal hello",
      sent_frames(stream)[0],
      bytes([terminal.CM_HELLO, 22, 80, 24, 0, 0, 0]))

# Protocols before that carry the encoding we want and a launch mode, which
# moved from 1 to 2 when AppDirectGraphics was inserted ahead of it.
stream = stream_for(20)
stream._send_hello(80, 24)
check("legacy hello asks for ANSI and TerminalAttach",
      sent_frames(stream)[0],
      bytes([terminal.CM_HELLO, 20, 80, 24, 0, 0, 1, 0, 2]))
stream = stream_for(16)
stream._send_hello(80, 24)
check("older launch mode is 1",
      sent_frames(stream)[0][-1:], bytes([1]))

# Attaching names one terminal, and Herdr treats it as a one-time transition:
# a second attach to the same id must not put another one on the wire.
stream = stream_for(22)
stream.attach("term_65b07ee9b73a41")
stream.attach("term_65b07ee9b73a41")
frames = sent_frames(stream)
check("one attach frame", len(frames), 1)
check("attach names the terminal",
      frames[0],
      bytes([terminal.CM_ATTACH_TERMINAL, len("term_65b07ee9b73a41")])
      + b"term_65b07ee9b73a41" + b"\x00")
try:
    stream.attach("term_other")
    failures.append("FAIL attaching elsewhere on one connection should raise")
except terminal.TerminalError:
    pass

# Keystrokes go out as bytes, with the length in front and nothing else added.
stream = stream_for(22)
stream.input(b"\x1b[A")
check("input frame", sent_frames(stream)[0], bytes([terminal.CM_INPUT, 3]) + b"\x1b[A")

# Resize gained pixel_mouse in 22 and lacks it before.
stream = stream_for(22)
stream.resize(100, 30)
check("resize 22", sent_frames(stream)[0], bytes([terminal.CM_RESIZE, 100, 30, 0, 0, 0]))
stream = stream_for(20)
stream.resize(100, 30)
check("resize 20", sent_frames(stream)[0], bytes([terminal.CM_RESIZE, 100, 30, 0, 0]))

# A protocol whose codec was never verified is refused rather than guessed at.
check("22 is supported", terminal.supported_protocol(22), True)
check("20 is supported", terminal.supported_protocol(20), True)
check("21 is not", terminal.supported_protocol(21), False)
check("13 is not", terminal.supported_protocol(13), False)
check("a missing protocol is not", terminal.supported_protocol(None), False)
try:
    terminal.TerminalStream("/dev/null", 21, on_data=lambda d: None)
    failures.append("FAIL protocol 21 should be refused")
except terminal.TerminalError:
    pass

# The server's own messages: a welcome that agrees, and a terminal frame whose
# size is reported once and then only when it changes.
def decode_with(stream, payload):
    stream._handle(payload)


stream = stream_for(22)
w = bincode.BinWriter()
w.variant(terminal.SM_V22["welcome"])
w.varint(22)
w.varint(1)          # TerminalAnsi
w.option(None, lambda v: w.string(v))
decode_with(stream, w.to_bytes())
check("a matching welcome is accepted", stream._welcome_error, None)

stream = stream_for(22)
w = bincode.BinWriter()
w.variant(terminal.SM_V22["welcome"])
w.varint(22)
w.varint(0)          # the semantic frame codec, which this gateway cannot draw
w.option(None, lambda v: w.string(v))
decode_with(stream, w.to_bytes())
check("a frame-encoded welcome is refused",
      "unsupported encoding" in (stream._welcome_error or ""), True)

seen = {"data": [], "sizes": []}
stream = terminal.TerminalStream(
    "/dev/null", 22,
    on_data=lambda d: seen["data"].append(d),
    on_size=lambda c, r: seen["sizes"].append((c, r)))
stream._sock = FakeUnix()


def terminal_frame(width, height, data, seq=1, full=True):
    w = bincode.BinWriter()
    w.variant(terminal.SM_V22["terminal"])
    w.varint(seq)
    w.varint(width)
    w.varint(height)
    w.bool(full)
    w.bytes(data)
    return w.to_bytes()


decode_with(stream, terminal_frame(80, 24, b"\x1b[2J"))
decode_with(stream, terminal_frame(80, 24, b"hello"))
decode_with(stream, terminal_frame(59, 43, b"resized"))
check("every frame's bytes arrive", seen["data"], [b"\x1b[2J", b"hello", b"resized"])
check("the size is announced on change only", seen["sizes"], [(80, 24), (59, 43)])


# -- WebSocket framing ------------------------------------------------------

# RFC 6455's own example.
check("accept key", wsproto.accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
      "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")


class FakeSocket:
    """Feeds a WebSocket bytes from a script and keeps what it writes."""

    def __init__(self, data=b""):
        self.inbox = data
        self.sent = b""

    def recv(self, n):
        chunk, self.inbox = self.inbox[:n], self.inbox[n:]
        return chunk

    def sendall(self, data):
        self.sent += data

    def shutdown(self, how):
        pass

    def close(self):
        pass


def client_frame(opcode, payload, fin=True, mask=b"\xa1\xb2\xc3\xd4"):
    """A frame as a browser sends it: masked, because they always are."""
    head = bytes([(0x80 if fin else 0) | opcode])
    length = len(payload)
    if length < 126:
        head += bytes([0x80 | length])
    elif length <= 0xFFFF:
        head += bytes([0x80 | 126]) + struct.pack(">H", length)
    else:
        head += bytes([0x80 | 127]) + struct.pack(">Q", length)
    masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
    return head + mask + masked


ws = wsproto.WebSocket(FakeSocket(client_frame(wsproto.OP_BINARY, b"ls -la\r")))
check("unmasked payload", ws.recv(), (wsproto.OP_BINARY, b"ls -la\r"))

# A paste arrives fragmented; the message is the pieces joined, once.
sock = FakeSocket(
    client_frame(wsproto.OP_TEXT, b'{"type":"re', fin=False)
    + client_frame(wsproto.OP_CONT, b'size"}', fin=True)
)
check("continuation frames", wsproto.WebSocket(sock).recv(),
      (wsproto.OP_TEXT, b'{"type":"resize"}'))

# A ping in the middle is answered here and never handed up.
sock = FakeSocket(client_frame(wsproto.OP_PING, b"hi") + client_frame(wsproto.OP_BINARY, b"y"))
ws = wsproto.WebSocket(sock)
check("ping is not a message", ws.recv(), (wsproto.OP_BINARY, b"y"))
check("pong was sent", sock.sent[:2], bytes([0x80 | wsproto.OP_PONG, 2]))

check("close ends the stream", wsproto.WebSocket(FakeSocket(client_frame(wsproto.OP_CLOSE, b""))).recv(), None)
check("a cut connection ends it too", wsproto.WebSocket(FakeSocket(b"")).recv(), None)

# An unmasked client frame is a broken or hostile peer: the connection ends
# rather than the frame being taken as a message.
unmasked = wsproto.WebSocket(FakeSocket(bytes([0x81, 1, 65])))
check("an unmasked frame is refused", unmasked.recv(), None)
check("and the connection is closed", unmasked.closed, True)

# A message larger than anything a terminal sends ends it too.
huge = wsproto.WebSocket(FakeSocket(client_frame(wsproto.OP_BINARY, b"x" * (wsproto.MAX_MESSAGE + 1))))
check("an oversized message is refused", huge.recv(), None)

# Server frames carry no mask, and the length takes the right shape.
for payload, head in ((b"x" * 10, bytes([0x82, 10])),
                      (b"x" * 300, bytes([0x82, 126]) + struct.pack(">H", 300)),
                      (b"x" * 70000, bytes([0x82, 127]) + struct.pack(">Q", 70000))):
    sock = FakeSocket()
    wsproto.WebSocket(sock).send_bytes(payload)
    check(f"server frame header for {len(payload)} bytes", sock.sent[:len(head)], head)

# -- git --------------------------------------------------------------------

def git(root, *args):
    subprocess.run(["git", "-C", str(root), *args], check=True,
                   capture_output=True, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "repo"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    (root / "kept.txt").write_text("one\ntwo\nthree\n")
    (root / "gone.txt").write_text("delete me\n")
    (root / "old name.txt").write_text("renamed later\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "first")

    # Every shape the view has to draw, including the ones that used to break
    # a text-format parse: a space in a path, and a rename.
    (root / "kept.txt").write_text("one\ntwo changed\nthree\nfour\n")
    (root / "gone.txt").unlink()
    git(root, "mv", "old name.txt", "new name.txt")
    (root / "fresh file.txt").write_text("a\nb\n")
    (root / "blob.bin").write_bytes(bytes(range(256)))

    result = gitdiff.changed_files(str(root))
    check("it is a repository", result["repo"], True)
    check("branch", result["branch"], "main")
    files = {f["path"]: f for f in result["files"]}

    check("a modified file is counted",
          (files["kept.txt"]["added"], files["kept.txt"]["removed"]), (2, 1))
    check("a deleted file is listed", files["gone.txt"]["worktree_status"], "D")
    check("a renamed file keeps its old name", files["new name.txt"]["old_path"], "old name.txt")
    check("a path with a space survives", "fresh file.txt" in files, True)
    check("an untracked file is all addition",
          (files["fresh file.txt"]["added"], files["fresh file.txt"]["untracked"]), (2, True))
    check("a binary file is not counted in lines", files["blob.bin"]["binary"], True)

    # The diff of a tracked file is against HEAD; of an untracked one, against
    # nothing at all.
    patch = gitdiff.file_diff(str(root), "kept.txt")["patch"]
    check("tracked diff is against HEAD", "+two changed" in patch and "-two" in patch, True)
    fresh = gitdiff.file_diff(str(root), "fresh file.txt")
    check("untracked diff is a new file", fresh["tracked"], False)
    check("untracked diff has the content", "+a" in fresh["patch"], True)
    check("untracked diff names the file relatively",
          "b/fresh file.txt" in fresh["patch"], True)

    # Paths are the client's to name, so they are the server's to check.
    for bad in ("../escape.txt", "/etc/passwd", "sub/../../escape.txt"):
        try:
            gitdiff.file_diff(str(root), bad)
            failures.append(f"FAIL {bad} should be refused")
        except gitdiff.GitError:
            pass

    # Somewhere that is not a repository is an answer, not an error.
    check("no repository", gitdiff.changed_files(tmp)["repo"], False)
    check("nowhere at all", gitdiff.changed_files("/nonexistent/path")["repo"], False)

# ---------------------------------------------------------------------------

if failures:
    print("\n".join(failures))
    print(f"\n{len(failures)} failed")
    sys.exit(1)
print("all gateway tests passed")
