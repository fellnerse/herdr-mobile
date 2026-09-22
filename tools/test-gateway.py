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
import json
import re
import struct
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gateway"))

# Never write into the state dir a running gateway is using: these tests drive
# the real dispatcher, and it keeps the screens it acts on.
os.environ["SHEEPIT_STATE_DIR"] = tempfile.mkdtemp(prefix="sheepit-test-")

import bincode  # noqa: E402
import gitdiff  # noqa: E402
import machine  # noqa: E402
import server  # noqa: E402
import terminal  # noqa: E402
import wsproto  # noqa: E402

failures = []


def check(name, actual, expected):
    if actual != expected:
        failures.append(f"FAIL {name}\n  expected {expected!r}\n  actual   {actual!r}")


def error_of(call) -> str:
    """What a call refuses with, as the message somebody would have to read."""
    try:
        call()
    except Exception as e:
        return str(e)
    return "no error raised"


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

# -- the rows the phone lists -----------------------------------------------

# Three calls to Herdr become one list, and the shape of it is what the phone
# draws: a project per workspace, a row per tab, in the order the desktop is
# showing at the same moment.


def ws(wid, number, label, focused=False):
    return {"workspace_id": wid, "number": number, "label": label,
            "focused": focused, "active_tab_id": f"{wid}:t1"}


def tab(wid, number, label=None):
    return {"tab_id": f"{wid}:t{number}", "workspace_id": wid,
            "number": number, "label": label if label is not None else str(number)}


def pane(pid, wid, tid, cwd="/repos/x", focused=False):
    return {"pane_id": pid, "workspace_id": wid, "tab_id": f"{wid}:t{tid}",
            "cwd": cwd, "focused": focused}


def agent(pid, wid, tid, status="working", seq=1):
    return {"pane_id": pid, "workspace_id": wid, "tab_id": f"{wid}:t{tid}",
            "agent": "claude", "agent_status": status, "state_change_seq": seq,
            "terminal_title_stripped": "doing a thing", "cwd": "/repos/x"}


WORKSPACES = [ws("wC", 2, "second"), ws("w3", 1, "first")]
TABS = [tab("w3", 1), tab("w3", 3, "build"), tab("wC", 1)]
PANES = [pane("w3:p1", "w3", 1), pane("w3:p3", "w3", 3), pane("wC:p1", "wC", 1)]
AGENTS = [agent("w3:p1", "w3", 1)]

rows = server.build_agent_rows(WORKSPACES, TABS, PANES, AGENTS)

check("a row per tab, whether or not an agent is in it", len(rows), 3)
check("workspaces come in the desktop's own order",
      [r["name"] for r in rows], ["first", "first", "second"])
check("and a workspace's tabs in theirs",
      [r["tab_id"] for r in rows[:2]], ["w3:t1", "w3:t3"])
check("the agent's tab carries the agent", rows[0]["has_agent"], True)
check("with what it is doing", rows[0]["status"], "working")
check("and what it is called", rows[0]["title"], "doing a thing")
check("a tab with no agent is still a row", rows[1]["has_agent"], False)
check("which says nothing about an agent", rows[1]["status"], "unknown")
check("the tab's own label is passed on, numbered or not",
      [r["tab_label"] for r in rows[:2]], ["1", "build"])
check("as is its number", [r["tab_number"] for r in rows[:2]], [1, 3])

# A split tab runs two agents at once. Listing one of them would hide the
# other entirely, which is the failure this shape exists to prevent.
split_panes = PANES + [pane("w3:p7", "w3", 1)]
split_agents = AGENTS + [agent("w3:p7", "w3", 1, status="blocked")]
split = server.build_agent_rows(WORKSPACES, TABS, split_panes, split_agents)
first_tab = [r for r in split if r["tab_id"] == "w3:t1"]
check("both agents of a split tab get a row", len(first_tab), 2)
check("and say so", [r["split"] for r in first_tab], [True, True])
check("one tab is still one tab elsewhere",
      [r["split"] for r in split if r["tab_id"] != "w3:t1"], [False, False])

# A tab with several panes but no agent is one row, not one per pane.
quiet_panes = [pane("wC:p1", "wC", 1), pane("wC:p4", "wC", 1, focused=True)]
quiet = server.build_agent_rows([ws("wC", 1, "second")], [tab("wC", 1)], quiet_panes, [])
check("a split with no agent is a single row", len(quiet), 1)
check("on the pane the tab is actually on", quiet[0]["pane_id"], "wC:p4")

# A workspace with no pane at all is mid-creation, not a row.
check("a workspace with nothing in it is skipped",
      server.build_agent_rows([ws("wZ", 1, "new")], [], [], []), [])

# An older Herdr that does not answer tab.list still has to be usable: the
# panes know which tab they are in, and that is enough to group them.
no_tabs = server.build_agent_rows(WORKSPACES, [], PANES, AGENTS)
check("tabs are recovered from the panes when tab.list is silent",
      [r["tab_id"] for r in no_tabs], ["w3:t1", "w3:t3", "wC:t1"])
check("and the agent is still found", no_tabs[0]["has_agent"], True)

# A row's name is the project's, because that is how the list draws it. Anything
# reading the rows flat - the notification naming what just finished - has to be
# able to tell two agents in one project apart.
check("one agent per project is named after the project",
      [r["display_name"] for r in rows], ["first", "first", "second"])
check("two agents in one project say which tab",
      [r["display_name"] for r in first_tab],
      ["first \u00b7 tab 1 \u00b7 p1", "first \u00b7 tab 1 \u00b7 p7"])
named = server.build_agent_rows(
    WORKSPACES,
    [tab("w3", 1, "build"), tab("w3", 3, "ship")],
    [pane("w3:p1", "w3", 1), pane("w3:p3", "w3", 3)],
    [agent("w3:p1", "w3", 1), agent("w3:p3", "w3", 3)],
)
check("and a named tab is named, not numbered",
      [r["display_name"] for r in named], ["first \u00b7 build", "first \u00b7 ship"])

# -- labels typed on a phone ------------------------------------------------

# A label goes into the laptop's workspace strip, so what arrives is trimmed
# rather than passed on whole.
check("a label is trimmed", server.clean_label("  build  "), "build")
check("newlines are not labels", server.clean_label("one\ntwo"), "one two")
check("a label is capped", len(server.clean_label("x" * 500)), server.MAX_LABEL)
check("nothing is not a label", server.clean_label("   "), "")
check("and neither is a number", server.clean_label(7), "")
check("or nothing at all", server.clean_label(None), "")

# ---------------------------------------------------------------------------
# What the phone groups the flock by: the repository a workspace belongs to,
# so the scheduler's worktrees land under the project they were cut from
# rather than in a project each.

def workspace(ws_id, number, label, repo_root=None, checkout=None):
    ws = {"workspace_id": ws_id, "number": number, "label": label,
          "active_tab_id": f"{ws_id}:t1"}
    if repo_root:
        ws["worktree"] = {
            "repo_root": repo_root,
            "repo_name": repo_root.rsplit("/", 1)[-1],
            "checkout_path": checkout or repo_root,
            "is_linked_worktree": bool(checkout) and checkout != repo_root,
        }
    return ws


def pane(pane_id, ws_id, cwd):
    return {"pane_id": pane_id, "workspace_id": ws_id,
            "tab_id": f"{ws_id}:t1", "cwd": cwd}


ws_list = [
    workspace("wA", 1, "api", "/p/api"),
    workspace("wS", 2, "sheep #4", "/p/api", "/root/.herdr/worktrees/api/sheep-task-4"),
    workspace("wH", 3, "api"),  # opened by hand: Herdr knows of no worktree
    workspace("wN", 4, "notes"),
]
panes = [
    pane("wA:p1", "wA", "/p/api"),
    pane("wS:p1", "wS", "/root/.herdr/worktrees/api/sheep-task-4"),
    pane("wH:p1", "wH", "/p/api"),
    pane("wN:p1", "wN", ""),
]
agents = [{"pane_id": p["pane_id"], "agent_status": "idle"} for p in panes]
rows = {r["pane_id"]: r for r in server.build_agent_rows(ws_list, [], panes, agents)}

check("a checkout is its own repository", rows["wA:p1"]["project"], "/p/api")
check("a worktree belongs to the repository it came from",
      rows["wS:p1"]["project"], "/p/api")
check("and is named after it", rows["wS:p1"]["project_name"], "api")
check("a hand-opened workspace falls back to its directory",
      rows["wH:p1"]["project"], "/p/api")
check("a pane with nowhere to be still has a heading",
      rows["wN:p1"]["project_name"], "notes")

# Whether the heading can offer to cut another worktree, and which row to cut
# from. A branch started off a linked worktree starts on whatever that worktree
# was left sitting on, so the project's own checkout is worth telling apart.
check("a checkout can be cut from",
      [rows["wA:p1"]["repo"], rows["wA:p1"]["main_checkout"]], [True, True])
check("so can a worktree, but not as the place to cut from",
      [rows["wS:p1"]["repo"], rows["wS:p1"]["main_checkout"]], [True, False])
check("a workspace Herdr knows no repository for cannot",
      [rows["wH:p1"]["repo"], rows["wN:p1"]["repo"]], [False, False])

# ---------------------------------------------------------------------------
# The branch a removed worktree leaves behind. Herdr deletes the checkout and
# keeps the ref, so this is the other half - and it is the half that can still
# be holding the only copy of an afternoon's work.

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "repo"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    (root / "f.txt").write_text("one\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "first")

    # A root is the top of a working tree and nothing else: not a directory
    # inside one, and not a directory that is no repository at all.
    (root / "sub").mkdir()
    check("a working tree's top is a root", gitdiff.is_repo_root(str(root)), True)
    check("a directory inside one is not", gitdiff.is_repo_root(str(root / "sub")), False)
    check("and neither is somewhere else", gitdiff.is_repo_root(str(Path(tmp))), False)
    check("nor nothing at all", gitdiff.is_repo_root(""), False)

    # A branch whose commits are all merged already is tidy-up, and goes.
    git(root, "branch", "merged")
    gitdiff.delete_branch(str(root), "merged")
    check("a merged branch is deleted",
          "merged" in gitdiff.run_git(str(root), ["branch", "--list", "merged"]), False)

    # One with work on it is refused, in git's own words, until it is forced.
    git(root, "checkout", "-q", "-b", "unmerged")
    (root / "f.txt").write_text("two\n")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "work nobody merged")
    git(root, "checkout", "-q", "main")

    check("an unmerged branch is refused",
          "not fully merged" in error_of(lambda: gitdiff.delete_branch(str(root), "unmerged")),
          True)
    check("and is still there afterwards",
          "unmerged" in gitdiff.run_git(str(root), ["branch", "--list", "unmerged"]), True)
    gitdiff.delete_branch(str(root), "unmerged", force=True)
    check("forcing deletes it",
          "unmerged" in gitdiff.run_git(str(root), ["branch", "--list", "unmerged"]), False)

    # A name that could be read as a flag is a name, not an option - `-D` must
    # not arrive by way of the branch argument.
    check("a branch named like a flag is refused",
          error_of(lambda: gitdiff.delete_branch(str(root), "-D")), "bad branch name")
    check("and so is no name at all",
          error_of(lambda: gitdiff.delete_branch(str(root), "")), "bad branch name")
    # Nothing to delete is git's answer, not a crash.
    check("a branch that is not there says so",
          "not found" in error_of(lambda: gitdiff.delete_branch(str(root), "never")), True)

# ---------------------------------------------------------------------------
# Images from the phone. The one thing a phone has that a laptop does not, and
# it lands inside a repository somebody is working in - so where it goes, what
# it is called, and what git makes of it all have to be right.

with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp) / "project"
    repo.mkdir()
    git(repo, "init", "-q")

    png = b"\x89PNG\r\n\x1a\n" + b"pretend this is a screenshot"
    rel = server.save_attachment(str(repo), png, "image/png")

    check("the path is relative to the agent's own directory", rel.startswith(".sheepit/"), True)
    check("the bytes are what arrived", (repo / rel).read_bytes(), png)
    check("the name says when it came", rel.split("/")[1][:8].isdigit(), True)

    # The content type names the file, because the client's filename is a
    # string from a phone and belongs to nobody this server trusts.
    check("a jpeg is a .jpg", server.save_attachment(str(repo), b"x", "image/jpeg").endswith(".jpg"), True)
    check("a type with parameters still lands",
          server.save_attachment(str(repo), b"x", "image/png; charset=binary").endswith(".png"), True)
    for refused in ("text/html", "application/x-sh", "", "image/svg+xml"):
        try:
            server.save_attachment(str(repo), b"x", refused)
            failures.append(f"FAIL {refused!r} should be refused")
        except ValueError:
            pass

    # Two in the same second must not be one file.
    pair = {server.save_attachment(str(repo), b"a", "image/png"),
            server.save_attachment(str(repo), b"b", "image/png")}
    check("two at once are two files", len(pair), 2)

    # Excluded for this clone only: nothing a commit could pick up.
    exclude = (repo / ".git/info/exclude").read_text()
    check("the inbox is excluded", ".sheepit/" in exclude.split(), True)
    server.save_attachment(str(repo), b"x", "image/png")
    check("and excluded once, however many images arrive",
          (repo / ".git/info/exclude").read_text().count(".sheepit/"), 1)
    check("git sees nothing to commit",
          subprocess.run(["git", "-C", str(repo), "status", "--porcelain"],
                         capture_output=True, text=True).stdout.strip(), "")

    # Old images age out; the ones you just sent do not.
    old = repo / ".sheepit" / "20200101-000000-dead.png"
    old.write_bytes(b"x")
    os.utime(old, (0, 0))
    fresh = server.save_attachment(str(repo), b"x", "image/png")
    check("a week-old image is gone", old.exists(), False)
    check("today's is not", (repo / fresh).exists(), True)

    # Somewhere that is not a directory is an answer, not a traceback.
    try:
        server.save_attachment(str(Path(tmp) / "nowhere"), b"x", "image/png")
        failures.append("FAIL a missing directory should be refused")
    except ValueError:
        pass

# A worktree keeps its .git as a file pointing elsewhere, which is exactly
# where a naive `.git/info/exclude` writes into a directory that is not there.
with tempfile.TemporaryDirectory() as tmp:
    main = Path(tmp) / "main"
    main.mkdir()
    git(main, "init", "-q")
    git(main, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
        "--allow-empty", "-m", "root")
    tree = Path(tmp) / "tree"
    git(main, "worktree", "add", "-q", "-b", "side", str(tree))
    server.save_attachment(str(tree), b"x", "image/png")
    check("a worktree excludes it too",
          ".sheepit/" in (main / ".git/info/exclude").read_text().split(), True)
    check("and shows nothing to commit",
          subprocess.run(["git", "-C", str(tree), "status", "--porcelain"],
                         capture_output=True, text=True).stdout.strip(), "")

# ---------------------------------------------------------------------------
# Who gets a notification. The phone buzzing for things that are not waiting on
# anybody is worse than it sounds: it teaches you to ignore the ones that are.

def sweeps(*states):
    """Run a watcher over successive snapshots of one pane, and report the
    sweeps it would have pushed for."""
    watcher = server.StatusWatcher()
    watcher.observe({"p1": states[0]}, tell=False)
    return [bool(watcher.observe({"p1": s})) for s in states[1:]]

check("a finished turn is worth saying",
      sweeps("working", "working", "done"), [False, True])
check("a question is worth saying",
      sweeps("working", "blocked"), [True])
check("the prompt box is not",
      sweeps("working", "idle"), [False])
check("and neither is losing sight of the agent",
      sweeps("working", "unknown"), [False])
check("still done is not done again",
      sweeps("working", "done", "done", "done"), [True, False, False])
check("idling after a finished turn says nothing further",
      sweeps("working", "done", "idle", "done"), [True, False, False])
check("the next piece of work earns the next notification",
      sweeps("working", "done", "working", "done"), [True, False, True])
check("a question answered on the desktop, then another",
      sweeps("working", "blocked", "working", "blocked"), [True, False, True])
check("an agent that was already waiting when we started up is not news",
      sweeps("done", "done"), [False])
# Herdr can report the prompt box for a sweep on its way to marking the turn
# finished, so the work is remembered across an idle rather than dropped there:
# a missed notification is the one failure with no way to notice it.
check("a turn that idles on its way to finishing still counts",
      sweeps("working", "idle", "done"), [False, True])
check("but being interrupted into the prompt box never does",
      sweeps("working", "idle", "idle"), [False, False])

# A pane that closes takes its history with it.
watcher = server.StatusWatcher()
watcher.observe({"p1": "working"}, tell=False)
watcher.observe({})
check("a closed pane is forgotten", watcher.busy_since_told, set())

# -- what is left to spend --------------------------------------------------

# Both agents write their own usage down as they work, which is the only
# source that needs no credentials and the only one Codex has at all. Reading
# it wrong is invisible - a bar is drawn either way - so the shapes both tools
# actually write are pinned here.

import json as _json
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scheduler import quota
from scheduler import config as sched_config
from scheduler import dispatch as sched_dispatch

# Claude Code's own cache, as it sits in .claude.json: the endpoint's payload,
# stamped with the account it belongs to and when it was taken.
CLAUDE_STATE = {
    "oauthAccount": {"accountUuid": "a89e-1"},
    "cachedUsageUtilization": {
        "fetchedAtMs": 1789384457174,
        "accountUuid": "a89e-1",
        "utilization": {
            "five_hour": {"utilization": 66, "resets_at": "2026-09-14T16:10:00+00:00",
                          "locked_reason": None},
            "seven_day": {"utilization": 8, "resets_at": "2026-09-21T11:00:00+00:00",
                          "locked_reason": None},
            "seven_day_opus": None,
            "extra_usage": {"something_else": True},
        },
    },
}

with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp)
    state = home / ".claude.json"
    state.write_text(_json.dumps(CLAUDE_STATE))

    q = quota._claude_observed(state)
    check("Claude's own note is a usage reading", [b.name for b in q.buckets],
          ["five_hour", "seven_day"])
    check("with the numbers it wrote", [b.utilization for b in q.buckets], [66.0, 8.0])
    check("and the account it wrote them for", q.account, "a89e-1")
    check("it is never mistaken for a live answer", (q.source, q.stale), ("observed", True))
    check("dated by the agent, not by us", q.fetched_at.year, 2026)
    # A plan slot this account does not have is not a window at zero.
    check("an empty slot is not a bucket", "seven_day_opus" in [b.name for b in q.buckets], False)

    empty = home / "empty.json"
    empty.write_text("{}")
    check("a Claude that has written nothing down says so",
          error_of(lambda: quota._claude_observed(empty)), "Claude has written down no usage yet")
    check("and a missing file is not a crash",
          "no Claude state" in error_of(lambda: quota._claude_observed(home / "nope.json")), True)

# Codex records the limits of every turn in its session rollout. The newest
# line wins, the file is read from the end, and a line that is not JSON is a
# line, not a failure.
def codex_line(primary, secondary, when=1789387974):
    return _json.dumps({
        "timestamp": "2026-09-14T12:47:59Z",
        "payload": {"type": "token_count", "rate_limits": {
            "limit_id": "codex",
            "primary": {"used_percent": primary, "window_minutes": 300, "resets_at": when},
            "secondary": {"used_percent": secondary, "window_minutes": 10080, "resets_at": when},
        }},
    })


with tempfile.TemporaryDirectory() as tmp:
    home = Path(tmp)
    day = home / "sessions" / "2026" / "09" / "14"
    day.mkdir(parents=True)
    rollout = day / "rollout-2026-09-14T12-47-59-01a0.jsonl"
    rollout.write_text("\n".join([
        _json.dumps({"payload": {"type": "message", "text": "hello"}}),
        codex_line(12.0, 30.0),
        "{ this line is not json",
        codex_line(98.0, 87.0),
    ]) + "\n")

    q = quota._codex_observed(home)
    check("Codex's windows come off its rollout",
          [[b.name, b.utilization] for b in q.buckets],
          [["five_hour", 98.0], ["seven_day", 87.0]])
    check("the last word wins, not the first", q.buckets[0].utilization, 98.0)
    check("a reset time is a time", q.buckets[0].resets_at.year, 2026)
    check("and it says where it came from", (q.agent, q.source), ("codex", "observed"))

    # A session opened yesterday and still running is not in today's directory,
    # so the newest file is found by when it was written, not where it is filed.
    old_day = home / "sessions" / "2026" / "09" / "13"
    old_day.mkdir(parents=True)
    yesterday = old_day / "rollout-2026-09-13T09-00-00-01a0.jsonl"
    yesterday.write_text(codex_line(4.0, 5.0) + "\n")
    os.utime(yesterday, (time.time() + 60, time.time() + 60))
    check("a session still running from yesterday is the current one",
          quota._codex_observed(home).buckets[0].utilization, 4.0)

    quiet = Path(tmp) / "quiet"
    (quiet / "sessions").mkdir(parents=True)
    check("a Codex that has never reported is not an error to guess around",
          "no Codex session" in error_of(lambda: quota._codex_observed(quiet)), True)

# Whatever the window is measured in, it is named the way the other agent's
# windows are named: one vocabulary on screen.
check("five hours is five_hour", quota._codex_window_name(300), "five_hour")
check("a week is seven_day", quota._codex_window_name(10080), "seven_day")
check("an hour Codex invents later still reads", quota._codex_window_name(120), "2_hour")
check("and so does a day", quota._codex_window_name(2880), "2_day")
check("nothing at all is still a name", quota._codex_window_name(None), "window")

# -- reading Codex off its own screen ---------------------------------------

# Codex writes its usage down only when the model answers, so a window that
# reset while nobody was working still reads as full on disk. `/status` is the
# one reading that is current, and this is the box it draws.
CODEX_STATUS = """
+----------------------------------------------------------------------------+
|  >_ OpenAI Codex (v0.154.0)                                                 |
|  Account:              someone@example.com (Plus)                           |
|  Context window:       92% left (32.2K used / 258K)                         |
|  5h limit:             [####################] 100% left (resets 03:36 on 15 Sep) |
|  Weekly limit:         [#...................] 6% left (resets 10:14 on 19 Sep)   |
+----------------------------------------------------------------------------+
"""

windows = quota.parse_codex_status(CODEX_STATUS)
check("both windows come off the box", [b.name for b in windows],
      ["five_hour", "seven_day"])
# "100% left" is an empty window, not a full one - the one number on that
# screen that means the opposite of everywhere else in this codebase.
check("what is left is turned into what is spent",
      [b.utilization for b in windows], [0.0, 94.0])
check("a window with everything left is not spent", windows[0].is_spent(), False)
check("the context window is not a usage window", len(windows), 2)

five, week = windows
check("the reset keeps its wall clock time",
      [five.resets_at.astimezone().hour, five.resets_at.astimezone().minute], [3, 36])
check("and its day", week.resets_at.astimezone().day, 19)
check("a box with no limits in it reads as nothing",
      quota.parse_codex_status("just some output"), ())

# A time with no date is today's if it is still to come, and tomorrow's if it
# has already passed - a reset is hours away, never a year.
noon = datetime.now().astimezone().replace(hour=12, minute=0, second=0, microsecond=0)
check("a time later today stays today",
      quota._status_reset("23:30", None, None, noon).astimezone().day, noon.day)
check("a time already past is tomorrow's",
      quota._status_reset("06:00", None, None, noon).astimezone().day,
      (noon + timedelta(days=1)).day)

# -- reading Antigravity / OMP / Agy off agent.db ---------------------------

with tempfile.TemporaryDirectory() as tmp:
    db_dir = Path(tmp)
    db_file = db_dir / "agent.db"
    con = sqlite3.connect(db_file)
    con.execute("""
        CREATE TABLE cache (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        )
    """)
    report_data = {
        "value": {
            "provider": "google-antigravity",
            "fetchedAt": 1789726634001,
            "metadata": {"email": "test@example.com"},
            "raw": {
                "groups": [
                    {
                        "displayName": "Gemini Models",
                        "buckets": [
                            {
                                "bucketId": "gemini-5h",
                                "window": "5h",
                                "remainingFraction": 0.90,
                                "resetTime": "2026-09-18T22:30:00Z",
                            },
                            {
                                "bucketId": "gemini-weekly",
                                "window": "weekly",
                                "remainingFraction": 0.85,
                                "resetTime": "2026-09-23T06:00:00Z",
                            },
                        ],
                    },
                    {
                        "displayName": "Claude and GPT models",
                        "buckets": [
                            {
                                "bucketId": "3p-5h",
                                "window": "5h",
                                "remainingFraction": 1.0,
                                "resetTime": "2026-09-18T23:30:00Z",
                            },
                            {
                                "bucketId": "3p-weekly",
                                "window": "weekly",
                                "remainingFraction": 0.70,
                                "resetTime": "2026-09-19T06:00:00Z",
                            },
                        ],
                    },
                ]
            },
        }
    }
    con.execute(
        "INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
        ("usage_cache:report:2:google-antigravity:test", json.dumps(report_data), 1789842583),
    )
    con.commit()
    con.close()

    q_omp = quota.antigravity("omp", group="gemini", db_path=db_file)
    check("OMP gets five_hour and seven_day", [b.name for b in q_omp.buckets], ["five_hour", "seven_day"])
    check("OMP computes Gemini utilization correctly", [b.utilization for b in q_omp.buckets], [10.0, 15.0])
    check("OMP carries account email", q_omp.account, "test@example.com")

    q_agy = quota.antigravity("agy", group="3p", db_path=db_file)
    check("Agy gets five_hour and seven_day", [b.name for b in q_agy.buckets], ["five_hour", "seven_day"])
    check("Agy computes 3p utilization correctly", [b.utilization for b in q_agy.buckets], [0.0, 30.0])

    check("missing OMP DB raises QuotaError",
          "no OMP database" in error_of(lambda: quota.antigravity("omp", db_path=db_dir / "nonexistent.db")), True)

check("gemini model is not 3p", quota._model_is_3p("google-antigravity/gemini-3.8-flash"), False)
check("claude opus is 3p", quota._model_is_3p("Claude Opus 4.6 (Thinking)"), True)
check("gpt model is 3p", quota._model_is_3p("gpt-5.2"), True)
check("current('antigravity') maps to agy", quota.current("antigravity", ttl=0).agent, "agy")

# -- typing into somebody's session -----------------------------------------

# Asking a pane for its usage means sending a command to it, and a composer
# with a half-written prompt in it would send that too. This is the guard, and
# it is the difference between a reading and somebody's unfinished sentence
# going to their agent.
check("a half-written prompt is not an empty composer",
      server.composer_is_empty("> Next feat: Biome rework"), False)
check("nor is one that spans two lines",
      server.composer_is_empty("> Next feat:\n  and more about it"), False)
check("an empty composer is", server.composer_is_empty("> "), True)
check("and so is the placeholder the agent draws",
      server.composer_is_empty("> Ask Codex to do anything"), True)
check("a pane with no composer at all is left alone",
      server.composer_is_empty("some output\nand more"), False)
check("the composer is read from the bottom, not the top",
      server.composer_is_empty("> an old prompt, answered\nsome reply\n> "), True)

# -- what counts as out of usage --------------------------------------------

# A window is not a wall until it has nothing left. 87% of a weekly window is
# five days of perfectly good usage, and a queue that will not spend it is a
# queue that stopped working for the person typing into it. Only a locked
# window, or one within a percent of the top, is worth waiting out.
past = datetime.now(timezone.utc) - timedelta(minutes=30)
ahead = datetime.now(timezone.utc) + timedelta(hours=2)


def bucket(util, resets_at=None, locked=None):
    return quota.Bucket("five_hour", util, resets_at, locked)


check("most of a window gone is not a window spent", bucket(87.0, ahead).is_spent(), False)
check("nor is nearly all of it", bucket(98.0, ahead).is_spent(), False)
check("nor is all but a rounding error", bucket(99.5, ahead).is_spent(), False)
check("the cap itself is", bucket(100.0, ahead).is_spent(), True)
check("and a window the provider locked is, whatever it reads",
      bucket(3.0, ahead, "over_limit").is_spent(), True)

# A window whose reset time has passed has rolled over: an agent that finished
# a turn at 98% an hour before its window reopened is not at 98% now, and it is
# certainly not out.
check("a window that has come back is not spent", bucket(100.0, past).is_spent(), False)
check("and it knows it has come back", bucket(98.0, past).is_expired(), True)
check("a window with no reset time is taken at its word",
      bucket(100.0, None).is_spent(), True)

# The threshold is a colour on a bar and nothing else now: amber from there up,
# red at the cap. Whatever it is set to, a window with room in it is spendable.
check("the threshold does not decide what is spent",
      [b.is_spent() for b in (bucket(81.0, ahead), bucket(99.0, ahead))], [False, False])
check("amber starts at four fifths of a window",
      quota.DEFAULT_THRESHOLD, 80.0)
check("and the default the queue loads agrees with it",
      sched_config.load(Path("/nonexistent/scheduler.json")).threshold,
      quota.DEFAULT_THRESHOLD)

# What the queue does with a window, end to end. A hold is forever - nothing
# retries a prompt the sweep declined to send - so the only thing that may hold
# one is a window that is actually out.

def holds(reading):
    """Whether the sweep would hold this agent's panes."""
    dispatcher = sched_dispatch.Dispatcher.__new__(sched_dispatch.Dispatcher)
    original = quota.current
    quota.current = reading
    try:
        return dispatcher.out_of_window("codex", ["wA:p1"])
    finally:
        quota.current = original


def reading(*buckets):
    def read(agent, *a, **kw):
        return quota.Quota(tuple(buckets), datetime.now(timezone.utc), stale=False,
                           agent=agent, source="api")
    return read


def refuses(agent, *a, **kw):
    raise quota.QuotaError("no credentials, no cache, no note")


# The case that started this: a weekly window at the cap, a prompt queued
# against it, and nothing in the way of handing it straight over.
check("a weekly window at the cap holds the queue",
      holds(reading(bucket(12.0, ahead), quota.Bucket("seven_day", 100.0, ahead, None))), True)
check("a five hour window at the cap holds it too",
      holds(reading(bucket(100.0, ahead))), True)
check("and so does an account the provider locked",
      holds(reading(bucket(40.0, ahead, "over_limit"))), True)

# Everything short of the cap is yours to spend.
check("most of a window gone holds nothing",
      holds(reading(bucket(87.0, ahead), quota.Bucket("seven_day", 94.0, ahead, None))), False)
check("nor does all but a rounding error", holds(reading(bucket(99.0, ahead))), False)

# A window that has already come back is not a wall, whatever it says.
check("a window that reopened holds nothing", holds(reading(bucket(100.0, past))), False)

# Not knowing is not knowing there is nothing left.
check("an agent nobody can price is delivered to", holds(refuses), False)

sweep_source = (Path(__file__).resolve().parent.parent
                / "gateway" / "scheduler" / "dispatch.py").read_text()
sweep_body = sweep_source[sweep_source.index("    def sweep("):sweep_source.index("    def out_of_window(")]
check("the sweep prices each agent separately", "agent_kind" in sweep_body, True)
check("and a pane that hit the wall is still parked", "self.stalls" in sweep_body, True)

# ---------------------------------------------------------------------------
# Picking back up after a usage window, which has exactly two ways to silently
# never happen: nothing is watching the pane, or usage says the wall is still
# there long after it came down. Both looked identical from the phone -- a queue
# with prompts in it and nothing being delivered -- so both are pinned here.

from datetime import datetime, timedelta, timezone  # noqa: E402

from scheduler import db as sched_db  # noqa: E402
from scheduler import quota as sched_quota  # noqa: E402
from scheduler.config import Config  # noqa: E402
from scheduler.dispatch import Dispatcher, RESUME_PROMPT  # noqa: E402

_now = datetime.now(timezone.utc)


def bucket(util, resets_in=None, locked=None, name="five_hour"):
    return sched_quota.Bucket(
        name, util, _now + resets_in if resets_in is not None else None, locked
    )


def quota_of(buckets, age=timedelta(0), stale=True):
    return sched_quota.Quota(tuple(buckets), _now - age, stale=stale)


# The frozen cache. A token that expires overnight makes every read from then on
# the same cached one, so a reading taken at a full window stays full forever --
# and a window whose own reset is in the past is the one reading we can prove is
# no longer about anything. Believing it is a queue that never moves again.
check("a cached window whose reset has passed stops blocking",
      quota_of([bucket(100.0, -timedelta(minutes=30))]).blockers(85.0), [])
check("and has nothing left to wait for",
      quota_of([bucket(100.0, -timedelta(minutes=30))]).resume_at(85.0), None)
check("a real wall still blocks",
      [b.name for b in quota_of([bucket(100.0, timedelta(hours=2))],
                                stale=False).blockers(85.0)], ["five_hour"])
check("a window that never said when it resets ages out of being trusted",
      quota_of([bucket(100.0)], age=timedelta(minutes=20)).blockers(85.0), [])
check("but not before the backoff it is entitled to",
      [b.name for b in quota_of([bucket(100.0)], age=timedelta(minutes=5)).blockers(85.0)],
      ["five_hour"])
check("a lock is a lock however old the reading",
      [b.name for b in quota_of([bucket(0.0, -timedelta(hours=1), locked="plan")],
                                age=timedelta(hours=1)).blockers(85.0)], ["five_hour"])
check("a fresh reading is never expired",
      quota_of([bucket(100.0, timedelta(hours=2))], stale=False).expired, False)


class FakePane:
    """One pane with an agent in it, and a record of what was done to it."""

    def __init__(self, status="idle", session="sess-abc", agent="claude", screen="",
                 after=""):
        self.status_value, self.session, self.keys, self.sent, self.typed = \
            status, session, [], [], []
        # Which agent is in the pane decides whose usage window it spends, so
        # the wall has to ask before it can price what it saw.
        self.agent = agent
        # What is on the pane when the wall comes and looks: a menu waiting to
        # be answered, or nothing in particular. `after` is what it becomes
        # once keys land, which is how a composer left holding the agent's own
        # command is modelled -- the screen answering changes.
        self.screen, self.after = screen, after

    def pane_read(self, pane_id, lines=60, source="recent_unwrapped"):
        return self.screen

    def agent_kind(self, pane_id):
        return self.agent

    def agents_by_pane(self):
        return {"wA:p1": {"pane_id": "wA:p1", "workspace_id": "wA", "cwd": "/root/x",
                          "agent_session": {"kind": "id", "value": self.session}}}

    def status(self, pane_id):
        return self.status_value

    def session_uuid(self, pane_id):
        return self.session

    def agent_send_keys(self, pane_id, keys):
        self.keys.append(keys)
        self.screen = self.after

    def agent_prompt(self, target, text):
        self.sent.append(text)

    def send_line(self, pane_id, text):
        self.typed.append(text)

    def report_queued(self, pane_id, count):
        pass

    def notify(self, *a, **k):
        pass


class Silent:
    """An event stream that reports nothing, so only the sweep is under test."""

    connected, started_at = True, 0.0

    def ensure(self, subs):
        pass

    def poll(self, timeout):
        return []

    def wake(self):
        pass


def fresh_db():
    return sched_db.connect(Path(tempfile.mkdtemp()) / "queue.sqlite3")


# The reported bug. Watching only the panes with something queued means a chat
# left running overnight -- which is the whole case for this existing -- is the
# one chat nothing is subscribed to when it runs out.
pane = FakePane()
d = Dispatcher(herdr=pane, events=Silent())
conn = fresh_db()
check("a pane with an agent and an empty queue is still watched",
      d.watched(conn), ["wA:p1"])

# Hitting the wall parks the pane and puts a resume in front of the queue, with
# enough recorded on it to survive the pane it belongs to.
import unittest.mock as _mock  # noqa: E402

with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    d.hit_the_wall(conn, "wA:p1", Config())
queued = sched_db.next_for_pane(conn, "wA:p1")
check("the wall queues a resume at the head", queued.prompt, RESUME_PROMPT)
check("with the session it has to resume into", queued.session_uuid, "sess-abc")
check("and somewhere to put it back", (queued.workspace_id, queued.cwd), ("wA", "/root/x"))
check("the halted turn is let go of", pane.keys, [["esc"]])

# A banner on a pane that is still working is not a wall -- it is scrollback, or
# a chat talking about usage limits. `esc` there throws away a live turn.
busy = FakePane(status="working")
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    Dispatcher(herdr=busy, events=Silent()).hit_the_wall(fresh_db(), "wA:p1", Config())
check("a working pane is never interrupted by a banner", busy.keys, [])

# End to end, from exactly the state the phone was stuck in: a resume and a
# typed prompt queued behind a cached, expired, hundred-percent window.
pane = FakePane()
d = Dispatcher(herdr=pane, events=Silent())
conn = fresh_db()
sched_db.add(conn, "wA:p1", RESUME_PROMPT, head=True,
             session_uuid="sess-abc", cwd="/root/x", workspace_id="wA")
sched_db.add(conn, "wA:p1", "continue, I told you so!")
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, -timedelta(minutes=30))],
                                              age=timedelta(minutes=30))), \
     _mock.patch("scheduler.dispatch._push"):
    d.sweep(conn, Config())
    d.sweep(conn, Config())
check("a stale wall no longer holds the queue shut",
      [pane.sent[0] == RESUME_PROMPT, pane.sent[1]], [True, "continue, I told you so!"])
check("and the queue empties", sched_db.count_waiting(conn, "wA:p1"), 0)

# ---------------------------------------------------------------------------
# The menu. Claude Code stopped just printing the wall and going idle: it opens
# `/rate-limit-options` and blocks on "What do you want to do?", which the queue
# used to report and then sit behind all night.

RATE_LIMIT_SCREEN = """\
  ⎿  You've hit your session limit · resets 12:50pm (UTC)
✳ Cogitated for 1m 29s · 1 shell still running

❯ /rate-limit-options

  What do you want to do?

  ❯ 1. Stop and wait for limit to reset
    2. Upgrade your plan

  Enter to confirm · Esc to cancel
"""

check("the wording on the screen is what makes us go and look",
      bool(sched_dispatch.LIMIT_RE.search(RATE_LIMIT_SCREEN)), True)
check("waiting is already selected, so it only needs confirming",
      sched_dispatch.wall_menu_keys(RATE_LIMIT_SCREEN), ["enter"])
check("and it is walked to when it is not",
      sched_dispatch.wall_menu_keys(
          "  What do you want to do?\n"
          "  ❯ 1. Upgrade your plan\n"
          "    2. Stop and wait for limit to reset\n"), ["down", "enter"])
# Both shapes the agent actually builds: waiting is put first or last depending
# on the account, and its label shortens to a bare "Stop". Pressing "1" would
# have bought a plan on two of these three.
check("waiting is found last in the list too",
      sched_dispatch.wall_menu_keys(
          "  ❯ 1. Upgrade your plan\n    2. Upgrade to Team plan\n    3. Stop\n"),
      ["down", "down", "enter"])
check("and walked back up to when the cursor is past it",
      sched_dispatch.wall_menu_keys(
          "    1. Stop\n  ❯ 2. Upgrade your plan\n"), ["up", "enter"])
# The one that must never fire: a menu offering only things that cost money, or
# a numbered list somebody's agent wrote. Both are for a person.
check("a menu with nothing about waiting in it is left for a person",
      sched_dispatch.wall_menu_keys("  ❯ 1. Upgrade your plan\n    2. Buy more usage\n"), None)
check("and prose that merely counts to two is not a menu",
      sched_dispatch.wall_menu_keys(
          "Here is the plan:\n1. stop and wait for limit to reset\n2. carry on\n"), None)

# Answering it is the whole point: the pane comes back free, the resume goes in
# front of the queue, and nobody is woken up to press "1".
menu = FakePane(screen=RATE_LIMIT_SCREEN)
conn = fresh_db()
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    Dispatcher(herdr=menu, events=Silent()).hit_the_wall(conn, "wA:p1", Config())
check("the menu is answered rather than escaped", menu.keys, [["enter"]])
check("and the resume is queued behind it",
      sched_db.next_for_pane(conn, "wA:p1").prompt, RESUME_PROMPT)

# The trap the screenshot showed: the agent opens the menu by typing the command
# into its own composer, so `/rate-limit-options` is sitting there when the menu
# goes away. The resume arrives hours later as text appended to whatever the
# composer holds — so left alone it is submitted as an argument to a slash
# command, swallowed, and recorded as sent.
LEFTOVER = "  ⎿  You've hit your session limit · resets 12:50pm (UTC)\n\n❯ /rate-limit-options\n"
menu = FakePane(screen=RATE_LIMIT_SCREEN, after=LEFTOVER)
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    Dispatcher(herdr=menu, events=Silent()).hit_the_wall(fresh_db(), "wA:p1", Config())
check("the command the agent typed for itself is cleared after answering",
      menu.keys, [["enter"], ["esc"]])

# And the line that must never be wiped: somebody's half-written prompt, left on
# the desktop in the same pane. It is not a slash command and not ours to drop.
typing = FakePane(screen=RATE_LIMIT_SCREEN, after="❯ I was in the middle of writing this")
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    Dispatcher(herdr=typing, events=Silent()).hit_the_wall(fresh_db(), "wA:p1", Config())
check("a half-written prompt in the composer survives the wall", typing.keys, [["enter"]])

# Usage is the authority for a banner, because a banner can be scrollback. A
# menu cannot: the agent drew it, now, and is stopped on it. A cached reading
# that has not caught up yet must not leave the pane sitting there.
menu = FakePane(screen=RATE_LIMIT_SCREEN)
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(12.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    Dispatcher(herdr=menu, events=Silent()).hit_the_wall(fresh_db(), "wA:p1", Config())
check("a menu outranks a usage reading that says the window is open",
      menu.keys, [["enter"]])

# ...but `working` is Herdr reading the spinner in the terminal title, and
# Claude Code keeps it turning while a background shell runs — "1 shell still
# running" is printed directly above the question. A menu waiting for a keypress
# outranks it, or the one case this exists for is the one it sits out.
spinning = FakePane(status="working", screen=RATE_LIMIT_SCREEN)
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    Dispatcher(herdr=spinning, events=Silent()).hit_the_wall(fresh_db(), "wA:p1", Config())
check("a menu on screen is answered even while herdr still says working",
      spinning.keys, [["enter"]])

# End to end, from the event Herdr actually sends to the key that answers the
# menu. The pieces above can all pass while the chain does nothing: the pattern
# never reaches Herdr, the match arrives and is dropped for being too early, or
# the pane is `blocked` and the sweep reports it and stops. This is the chain.
class Matched:
    """A stream that reports one limit match, then nothing, like Herdr's."""

    connected, started_at = True, -3600.0  # subscribed long ago, so no grace

    def __init__(self):
        self.events = [{"event": "pane.output_matched", "data": {"pane_id": "wA:p1"}}]
        self.subs = []

    def ensure(self, subs):
        self.subs = subs

    def wake(self):
        pass

    def poll(self, timeout):
        events, self.events = self.events, []
        return events


blocked = FakePane(status="blocked", screen=RATE_LIMIT_SCREEN)
events = Matched()
conn = fresh_db()
sched_db.add(conn, "wA:p1", "the thing I queued from the sofa")
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=3))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    Dispatcher(herdr=blocked, events=events).tick(conn, Config())
check("the pattern Herdr matches on carries its own case-insensitivity",
      [s["match"]["value"] for s in events.subs if s["type"] == "pane.output_matched"],
      [sched_dispatch.LIMIT_PATTERN])
check("and matches the screen the way Herdr would",
      bool(re.search(sched_dispatch.LIMIT_PATTERN, RATE_LIMIT_SCREEN)), True)
check("a chat blocked on the menu is answered, not just reported", blocked.keys, [["enter"]])
check("the prompt that was waiting behind it is still waiting", blocked.sent, [])
check("with the resume now in front of it",
      [p.prompt for p in sched_db.list_prompts(conn, "wA:p1", "waiting")],
      [RESUME_PROMPT, "the thing I queued from the sofa"])

# The five-hour bug, reproduced. The banner arrives while the turn is still
# running, so the wall rightly declines — then the turn dies of the very limit
# that printed it, the pane stops producing output, and the subscription (which
# matches on output) never fires again. Nothing came back, and the chat sat
# under its banner from 10:02 until a person noticed at 15:04.
BANNER_MIDTURN = (
    "● Bash(sed -n '60,95p' package.json)\n"
    "  ⎿  You've hit your session limit · resets 11:20am (UTC)\n"
    "✻ Cogitated for 45s · esc to interrupt\n"
)
dying = FakePane(status="working", screen=BANNER_MIDTURN, after=BANNER_MIDTURN)
d = Dispatcher(herdr=dying, events=Matched())
conn = fresh_db()
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=1))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    d.tick(conn, Config())                           # the one event that ever arrives
    check("a live turn is still not interrupted", dying.keys, [])
    check("but the pane is remembered", "wA:p1" in d.pending, True)

    dying.status_value = "idle"                      # the turn dies; no more output
    d.tick(conn, Config())                           # and no event with it
check("the wall comes back on its own and lets the turn go", dying.keys, [["esc"]])
queued = sched_db.next_for_pane(conn, "wA:p1")
check("and the resume is queued without anyone noticing",
      queued.prompt if queued else "nothing was queued at all", RESUME_PROMPT)
check("the pane is not looked at forever", "wA:p1" in d.pending, False)

# A pane that simply redrew past the banner is dropped, not watched for good.
recovered = FakePane(status="working", screen=BANNER_MIDTURN, after="● all done\n❯ ")
r = Dispatcher(herdr=recovered, events=Silent())
with _mock.patch.object(sched_quota, "current",
                        return_value=quota_of([bucket(100.0, timedelta(hours=1))], stale=False)), \
     _mock.patch("scheduler.dispatch._push"):
    r.hit_the_wall(fresh_db(), "wA:p1", Config())
    recovered.screen = "● all done\n❯ "
    r.look_again(fresh_db(), Config())
check("a banner that scrolled away stops being watched",
      [recovered.keys, "wA:p1" in r.pending], [[], False])

# A resume names a conversation. With no session there is none, and typing
# "continue where you left off" at a bare shell is worse than losing it.
shell = FakePane(session=None)
d = Dispatcher(herdr=shell, events=Silent())
conn = fresh_db()
sched_db.add(conn, "wB:p1", RESUME_PROMPT, head=True)
sched_db.add(conn, "wB:p1", "a real thing I typed")
with _mock.patch("scheduler.dispatch._push"):
    d.recover(conn, "wB:p1", "no-agent", Config())
    d.recover(conn, "wB:p1", "no-agent", Config())
check("an unrecoverable resume is dropped, not typed at a shell",
      shell.typed, ["a real thing I typed"])

# ---------------------------------------------------------------------------
# The machine's own load, under the subscriptions'. The parsing is the part
# that can be wrong quietly: a percentage read off the wrong column is still a
# plausible-looking number, and nobody checks a bar they believe.

PROC_STAT = (
    "cpu  100 10 40 800 50 0 0 0 0 0\n"
    "cpu0 50 5 20 400 25 0 0 0 0 0\n"
    "intr 12345\n"
)

check("the aggregate line is read, not the first core's",
      machine.parse_proc_stat(PROC_STAT), (150, 1000))

# Idle and iowait are both "not busy": an agent waiting on a disk is not what
# makes the machine feel buried, and counting it turns every build into 100%.
check("waiting on a disk is not being busy",
      machine.parse_proc_stat("cpu 0 0 0 0 100 0 0 0\n"), (0, 100))

check("guest time is not counted twice",
      machine.parse_proc_stat("cpu 1 1 1 1 1 1 1 1 900 900\n"), (6, 8))
check("a kernel with no cpu line is an error, not a zero",
      "cpu" in error_of(lambda: machine.parse_proc_stat("intr 1\n")), True)

check("two readings are a percentage", machine.cpu_delta((0, 0), (25, 100)), 25.0)
check("and counters that did not move are not a zero",
      machine.cpu_delta((5, 10), (5, 10)), None)
check("a counter that rolled over is not a negative percentage",
      machine.cpu_delta((90, 100), (10, 200)), 0.0)

# Disk. The trap here is counting the same bytes twice: sda1 is part of sda,
# and dm-3 is a view of it again through device-mapper - on a machine with LVM
# the naive sum reports three times the traffic that happened.
DISKSTATS = (
    "   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0\n"
    " 254       0 sda 100 0 200 0 50 0 400 0 0 0 0\n"
    " 254       1 sda1 10 0 20 0 5 0 40 0 0 0 0\n"
    " 253       3 dm-3 100 0 200 0 50 0 400 0 0 0 0\n"
)

check("only whole drives are counted, once",
      machine.parse_diskstats(DISKSTATS, {"sda"}),
      (200 * machine.SECTOR, 400 * machine.SECTOR))
check("a machine whose drives are all virtual reads zero",
      machine.parse_diskstats(DISKSTATS, set()), (0, 0))

# Network. Tailscale's traffic leaves through eth0 as well, wrapped, so an
# overlay counted beside the wire it rides on doubles every byte.
NET_DEV = (
    "Inter-|   Receive                        |  Transmit\n"
    " face |bytes packets errs drop fifo frame compressed multicast|"
    "bytes packets errs drop fifo colls carrier compressed\n"
    "    lo: 44076351951 4385895 0 0 0 0 0 0 44076351951 4385895 0 0 0 0 0 0\n"
    "  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n"
    "tailscale0: 500 5 0 0 0 0 0 0 700 7 0 0 0 0 0 0\n"
)

check("loopback and overlays are not the network", machine.parse_net_dev(NET_DEV),
      (1000, 2000))

# macOS prints a row per address, each carrying the whole interface's totals.
NETSTAT_IB = (
    "Name  Mtu   Network     Address        Ipkts Ierrs Ibytes Opkts Oerrs "
    "Obytes  Coll\n"
    "lo0   16384 <Link#1>                   9 0 900 9 0 900 0\n"
    "en0   1500  <Link#6>    ac:de:48:00:11 5 0 1000 4 0 2000 0\n"
    "en0   1500  192.168.1   192.168.1.5    5 - 1000 4 - 2000 -\n"
    "utun3 1280  <Link#18>                  1 0 77 1 0 88 0\n"
)

check("an interface is counted once, not once per address",
      machine.parse_netstat_ib(NETSTAT_IB), (1000, 2000))

# Swap. A machine that is swapping is already hurting, and one with swap off
# has no swap line at all rather than an empty bar.
check("swap is what is not free",
      machine.parse_swapinfo("SwapTotal: 1000 kB\nSwapFree: 250 kB\n"),
      (1000 * 1024, 750 * 1024))
check("and no swap is not a reading",
      machine.parse_swapinfo("SwapTotal: 0 kB\nSwapFree: 0 kB\n"), (0, 0))
check("macOS says it in megabytes",
      machine.parse_swapusage("total = 2048.00M  used = 512.00M  free = 1536.00M"),
      (2048 * 1024 * 1024, 512 * 1024 * 1024))
check("a Mac that has never swapped has no swap file",
      machine.parse_swapusage("total = 0.00M  used = 0.00M  free = 0.00M"), (0, 0))

# Counters into rates, over a span. A counter that went backwards is a reboot
# or a device that went away, not a negative throughput.
before = {"cpu": (0, 0), "disk": (0, 0), "net": (100, 100)}
after = {"cpu": (25, 100), "disk": (2048, 4096), "net": (50, 1124)}
moved = machine.rates(before, after, 2.0)
check("bytes become bytes a second",
      [moved["disk"], moved["net"]],
      [{"read": 1024.0, "write": 2048.0}, {"rx": 0.0, "tx": 512.0}])
check("a counter this machine does not keep stays unknown",
      machine.rates({"cpu": (0, 0), "disk": None, "net": None},
                    {"cpu": (1, 2), "disk": None, "net": None}, 1.0)["disk"], None)

MEMINFO = (
    "MemTotal:       16000000 kB\n"
    "MemFree:          200000 kB\n"
    "MemAvailable:    8000000 kB\n"
    "Buffers:          100000 kB\n"
    "Cached:          7000000 kB\n"
)

# Linux spends every spare page on cache: a machine with 200MB free and 8GB
# available is half used, not 99% gone, and the bar must say the former.
check("used is what is not available, not what is not free",
      machine.parse_meminfo(MEMINFO), (16000000 * 1024, 8000000 * 1024))

NO_AVAILABLE = (
    "MemTotal:       1000 kB\n"
    "MemFree:         100 kB\n"
    "Buffers:          50 kB\n"
    "Cached:          250 kB\n"
)
check("an old kernel adds the cache up itself",
      machine.parse_meminfo(NO_AVAILABLE), (1000 * 1024, 600 * 1024))
check("and a file without a total is an error",
      "MemTotal" in error_of(lambda: machine.parse_meminfo("MemFree: 1 kB\n")), True)

VM_STAT = (
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n"
    'Pages free:                          100.\n'
    'Pages active:                        200.\n'
    'Pages inactive:                      400.\n'
    'Pages speculative:                    50.\n'
    'Pages wired down:                    100.\n'
    'Pages occupied by compressor:         50.\n'
)

# Inactive and speculative pages are cache by another name - the same argument
# as MemAvailable, on the other operating system.
check("macOS counts active, wired and compressed",
      machine.parse_vm_stat(VM_STAT, 1000 * 16384), (1000 * 16384, 350 * 16384))
check("and never more than the machine has",
      machine.parse_vm_stat(VM_STAT, 100 * 16384), (100 * 16384, 100 * 16384))

# The whole reading, off whatever this machine is. Nothing here is asserted
# about the numbers themselves - only that taking them is not an exception and
# that the phone gets the shape it draws.
snap = machine.snapshot()
check("a reading can be taken at all", snap.get("ok"), True)
check("with a memory percentage in it",
      isinstance(snap["memory"]["percent"], float), True)
check("and a cpu percentage that is a percentage",
      snap["cpu"] is None or 0 <= snap["cpu"] <= 100, True)
check("every reading the strip draws is either there or honestly missing",
      sorted(k for k in snap if snap[k] is not None or k in ("swap", "disk", "net")),
      ["cores", "cpu", "disk", "host", "load", "memory", "net", "ok", "swap"])
check("and nothing flows backwards",
      all(v >= 0 for part in ("disk", "net") if snap[part]
          for v in snap[part].values()), True)

# -- the tokens the agents wrote down ---------------------------------------

# The tokens page reads the agents' own session logs rather than recording
# anything itself, which buys it a history on the day it ships and costs it
# every quirk of somebody else's file format. Three of those quirks can silently
# double or halve the week: Claude Code writes the same assistant message three
# times as it streams, a log is appended to between one reading and the next, and
# Codex reports its cached input inside the input it was part of.

import json  # noqa: E402

import tokens  # noqa: E402


def claude_line(stamp, model="claude-opus-5", ident="msg_1", request="req_1",
                cwd="/repo", **counts):
    return json.dumps({
        "type": "assistant",
        "timestamp": stamp,
        "cwd": cwd,
        "requestId": request,
        "message": {
            "id": ident,
            "model": model,
            "usage": {
                "input_tokens": counts.get("input", 0),
                "output_tokens": counts.get("output", 0),
                "cache_read_input_tokens": counts.get("cache_read", 0),
                "cache_creation_input_tokens": counts.get("cache_write", 0),
            },
        },
    })


def codex_line(stamp, last=None, total=None, model=None, cwd=None):
    info = {}
    if last is not None:
        info["last_token_usage"] = last
    if total is not None:
        info["total_token_usage"] = total
    payload = {"type": "token_count", "info": info}
    if model:
        payload["model"] = model
    if cwd:
        payload["cwd"] = cwd
    return json.dumps({"timestamp": stamp, "type": "event_msg", "payload": payload})


def tally(cache, path=None):
    """Everything counted so far, as {(hour, agent, model, project): counts}."""
    total = tokens.refresh(cache)
    return {tuple(key.split(tokens.SEP)): value for key, value in total.items()}


with tempfile.TemporaryDirectory(prefix="sheepit-logs-") as logs:
    root = Path(logs)
    projects = root / "claude" / "projects" / "-repo"
    projects.mkdir(parents=True)
    sessions = root / "codex" / "sessions" / "2026" / "09" / "18"
    sessions.mkdir(parents=True)
    repo = root / "repo"
    (repo / ".git").mkdir(parents=True)

    tokens.CLAUDE_PROJECTS = root / "claude" / "projects"
    tokens.CODEX_HOME = root / "codex"
    tokens._ROOTS.clear()

    # A message written three times as it streamed is one message. Counting the
    # copies would treble a week's tokens, and nothing on the page would look
    # wrong enough to notice.
    session = projects / "a.jsonl"
    line = claude_line("2026-09-18T05:30:00Z", cwd=str(repo), output=100, input=10,
                       cache_read=900, cache_write=50)
    session.write_text("\n".join([line, line, line]) + "\n")

    cache = {"version": tokens.CACHE_VERSION, "files": {}}
    counted = tally(cache)
    check("a streamed message is counted once", len(counted), 1)
    key = next(iter(counted))
    check("counted in the hour it happened", key[0], "2026-09-18T05:00:00Z")
    check("under the repository it was spent on", key[3], str(repo))
    check("with every kind of token",
          {k: counted[key][k] for k in tokens.KINDS},
          {"input": 10, "output": 100, "cache_read": 900, "cache_write": 50})

    # A log is appended to while the page is open. The pass that follows reads
    # only what arrived, and adds it to what was already counted.
    with session.open("a") as fh:
        fh.write(claude_line("2026-09-18T06:00:00Z", ident="msg_2", request="req_2",
                             cwd=str(repo), output=7) + "\n")
    counted = tally(cache)
    check("an appended turn joins the tally", len(counted), 2)
    check("and the turn before it is not counted twice",
          counted[key]["output"], 100)

    # A log that got shorter is not the log we were reading. Everything tallied
    # from it goes with it, or the new file's tokens land on top of the old
    # file's and the day reads as twice what it was.
    session.write_text(claude_line("2026-09-18T07:00:00Z", ident="msg_3",
                                   request="req_3", cwd=str(repo), output=5) + "\n")
    counted = tally(cache)
    check("a rewritten log is read again from the top", len(counted), 1)
    check("and says what it says now", list(counted.values())[0]["output"], 5)

    # Claude Code answering for itself - a refusal it composed, an error it
    # wrote down - made no request and spent nothing.
    session.write_text("\n".join([
        claude_line("2026-09-18T08:00:00Z", model="<synthetic>", ident="msg_4",
                    request="req_4", cwd=str(repo), output=99),
        claude_line("2026-09-18T08:00:00Z", ident="msg_5", request="req_5",
                    cwd=str(repo), output=1),
    ]) + "\n")
    counted = tally({"version": tokens.CACHE_VERSION, "files": {}})
    check("a synthetic message is not usage",
          [k[2] for k in counted], ["claude-opus-5"])

    # Codex says which model and which directory once, at the top; the usage
    # events themselves say neither.
    (sessions / "rollout.jsonl").write_text("\n".join([
        json.dumps({"timestamp": "2026-09-18T09:00:00Z", "type": "session_meta",
                    "payload": {"model": "gpt-5-codex", "cwd": str(repo)}}),
        codex_line("2026-09-18T09:30:00Z",
                   last={"input_tokens": 1000, "cached_input_tokens": 900,
                         "output_tokens": 50, "reasoning_output_tokens": 20}),
    ]) + "\n")
    counted = tally({"version": tokens.CACHE_VERSION, "files": {}})
    codex = {k: v for k, v in counted.items() if k[1] == "codex"}
    check("a rollout is read as codex", len(codex), 1)
    ckey = next(iter(codex))
    check("named by the model at the top of it", ckey[2], "gpt-5-codex")
    check("and the directory at the top of it", ckey[3], str(repo))
    # Cached input is part of the input Codex reports. Added as it stands, the
    # same tokens would be counted twice - once as fresh input, once as cache.
    check("cached input is taken out of the input",
          {k: codex[ckey][k] for k in tokens.KINDS},
          {"input": 100, "output": 70, "cache_read": 900, "cache_write": 0})

    # An older rollout carries only the running total for the session, so a turn
    # is the difference from the total before it.
    (sessions / "rollout.jsonl").write_text("\n".join([
        json.dumps({"timestamp": "2026-09-18T09:00:00Z", "type": "session_meta",
                    "payload": {"model": "gpt-5-codex", "cwd": str(repo)}}),
        codex_line("2026-09-18T09:30:00Z",
                   total={"input_tokens": 100, "output_tokens": 10}),
        codex_line("2026-09-18T09:40:00Z",
                   total={"input_tokens": 400, "output_tokens": 30}),
    ]) + "\n")
    counted = tally({"version": tokens.CACHE_VERSION, "files": {}})
    codex = {k: v for k, v in counted.items() if k[1] == "codex"}
    check("a running total is read as its differences",
          sum(v["input"] for v in codex.values()), 400)
    check("and its output likewise",
          sum(v["output"] for v in codex.values()), 30)

# A Herdr worktree is deleted the moment its branch lands, so the path is what
# has to say which repository last week's tokens were spent on - otherwise the
# biggest project on the page comes apart into a column per merged branch.
check("a worktree belongs to its repository",
      tokens.project_name(tokens.repo_root(str(tokens.WORKTREES / "herdr-mobile" / "gone"))),
      "herdr-mobile")
check("and somewhere that is no repository at all is still somewhere",
      tokens.project_name(tokens.repo_root("/nonexistent/elsewhere")), "elsewhere")


# -- heartbeat --------------------------------------------------------------

import heartbeat

# Config defaults and persistence
with tempfile.TemporaryDirectory(prefix="sheepit-heartbeat-") as hb_dir:
    cfg_path = Path(hb_dir) / "heartbeat.json"
    cfg = heartbeat.HeartbeatConfig.load(cfg_path)
    check("heartbeat default is disabled", cfg.enabled, False)
    check("heartbeat default interval is 24h", cfg.interval_hours, 24.0)
    check("heartbeat default sentinel is HEARTBEAT_OK", cfg.ok_sentinel, "HEARTBEAT_OK")
    check("heartbeat default prompt mentions live-web-stats-check",
          "/live-web-stats-check" in cfg.prompt, True)

    cfg.enabled = True
    cfg.interval_hours = 12.0
    cfg.ok_sentinel = "ALL_GOOD"
    cfg.save(cfg_path)

    loaded = heartbeat.HeartbeatConfig.load(cfg_path)
    check("heartbeat persistence: enabled", loaded.enabled, True)
    check("heartbeat persistence: interval", loaded.interval_hours, 12.0)
    check("heartbeat persistence: sentinel", loaded.ok_sentinel, "ALL_GOOD")

# Summary extraction
clean_summary = heartbeat.extract_summary("❯ /live-web-stats-check\nHEARTBEAT_OK\n")
check("extract_summary on clean run", clean_summary, "HEARTBEAT_OK")

anom_text = (
    "❯ /live-web-stats-check\n"
    "Found 3 critical Sentry crashes in prod checkout.\n"
    "TypeError: Cannot read properties of undefined (reading 'cart') at checkout.js:142\n"
    "GA4 event tracking is missing purchase events."
)
anom_summary = heartbeat.extract_summary(anom_text)
check("extract_summary extracts real findings",
      "3 critical Sentry crashes" in anom_summary, True)

# Notification interception: suppressed when sentinel is present
with tempfile.TemporaryDirectory(prefix="sheepit-hb-interceptor-") as hb_dir:
    cfg_path = Path(hb_dir) / "heartbeat.json"
    cfg = heartbeat.HeartbeatConfig(enabled=True, ok_sentinel="HEARTBEAT_OK")
    cfg.save(cfg_path)

    # Unregistered pane: let pass
    should_notify, meta = heartbeat.heartbeat_notification_interceptor(
        "w1:p1", {"pane_id": "w1:p1", "status": "done", "name": "web"}
    )
    check("untracked pane is not intercepted", (should_notify, meta), (True, None))

    # Active heartbeat: output contains sentinel -> suppress!
    heartbeat.mark_heartbeat_started("w1:p2", "HEARTBEAT_OK")
    check("pane is marked active", heartbeat.is_heartbeat_active("w1:p2"), True)

    # Mock pane_read on Herdr
    orig_pane_read = heartbeat.Herdr.pane_read
    try:
        heartbeat.Herdr.pane_read = lambda self, p, lines=40: "Auditing stats...\nHEARTBEAT_OK\n"
        should_notify, meta = heartbeat.heartbeat_notification_interceptor(
            "w1:p2", {"pane_id": "w1:p2", "status": "done", "name": "web"}
        )
        check("sentinel present suppresses push notification", should_notify, False)
        check("sentinel present returns no alert meta", meta, None)

        # Active heartbeat: output does NOT contain sentinel -> alert!
        heartbeat.mark_heartbeat_started("w1:p3", "HEARTBEAT_OK")
        heartbeat.Herdr.pane_read = lambda self, p, lines=40: anom_text
        should_notify, meta = heartbeat.heartbeat_notification_interceptor(
            "w1:p3", {"pane_id": "w1:p3", "status": "done", "name": "web", "display_name": "web-prod"}
        )
        check("sentinel missing triggers push notification", should_notify, True)
        check("alert title names agent", meta and meta.get("title"), "Heartbeat Alert: web-prod")
        check("alert body contains summary",
              meta and "3 critical Sentry crashes" in meta.get("body", ""), True)
    finally:
        heartbeat.Herdr.pane_read = orig_pane_read

# Notification policy filtering and _LAST_FINISHED
rows = {
    "w1:p2": {"pane_id": "w1:p2", "name": "clean-agent"},
    "w1:p3": {"pane_id": "w1:p3", "name": "alert-agent"},
}

server.register_notification_interceptor(
    lambda pane_id, row: (False, None) if pane_id == "w1:p2" else (True, {"title": "Test Alert", "body": "Details"})
)
notify_rows, c_title, c_body = server.filter_stopped_agents(["w1:p2", "w1:p3"], rows)
check("suppressed pane is excluded from notify_rows", [r["pane_id"] for r in notify_rows], ["w1:p3"])
check("custom alert title is captured", c_title, "Test Alert")
check("custom alert body is captured", c_body, "Details")

server.record_finished(notify_rows, title=c_title, body=c_body)
last = server.last_finished()
check("last_finished captures title", last.get("title"), "Test Alert")
check("last_finished captures body", last.get("body"), "Details")
check("last_finished captures agents", [a["pane_id"] for a in last.get("agents", [])], ["w1:p3"])

# Multiple heartbeats support
with tempfile.TemporaryDirectory(prefix="sheepit-multi-hb-") as hb_dir:
    cfg_path = Path(hb_dir) / "heartbeat.json"
    hb1 = heartbeat.HeartbeatItem(id="hb_web", name="Web Stats", interval_hours=24.0, enabled=True)
    hb2 = heartbeat.HeartbeatItem(id="hb_tests", name="Flaky Tests", interval_hours=6.0, enabled=False)
    cfg = heartbeat.HeartbeatConfig(heartbeats=[hb1, hb2])
    cfg.save(cfg_path)

    loaded = heartbeat.HeartbeatConfig.load(cfg_path)
    check("multiple heartbeats count", len(loaded.heartbeats), 2)
    check("first heartbeat name", loaded.heartbeats[0].name, "Web Stats")
    check("second heartbeat interval", loaded.heartbeats[1].interval_hours, 6.0)

    # Test delete handler
    class DummyHandler:
        def __init__(self):
            self.response = None
            self.status = None
        def send_json(self, data, status=200):
            self.response = data
            self.status = status

    orig_config_path = heartbeat.CONFIG_PATH
    try:
        heartbeat.CONFIG_PATH = cfg_path
        dh = DummyHandler()
        heartbeat.handle_post_heartbeat_delete(dh, {"id": "hb_web"})
        check("delete handler ok", dh.response.get("ok"), True)
        check("delete handler remaining heartbeats", len(dh.response.get("heartbeats", [])), 1)
        check("remaining heartbeat is hb_tests", dh.response.get("heartbeats", [])[0]["id"], "hb_tests")
    finally:
        heartbeat.CONFIG_PATH = orig_config_path

# Unattended launch flags: a heartbeat can't answer a permission prompt, so
# every harness needs whatever flag makes it run without one.
check("claude launch args default to auto permission mode",
      heartbeat._launch_args("claude", ""), ["--permission-mode", "auto"])
check("claude launch args carry a model override",
      heartbeat._launch_args("claude", "opus"), ["--model", "opus", "--permission-mode", "auto"])
check("omp launch args auto-approve",
      heartbeat._launch_args("omp", ""), ["--auto-approve"])
check("codex launch args never ask for approval",
      heartbeat._launch_args("codex", ""), ["--ask-for-approval", "never"])

# Model catalogs: asked of the harness (or its own alias system), not pinned
# to a snapshot that goes stale the day a new model ships.
claude_models = heartbeat.get_harness_models("claude")
check("claude model catalog offers current aliases, not pinned snapshots",
      {m["value"] for m in claude_models}, {"", "sonnet", "opus", "haiku", "fable"})
codex_models = heartbeat.get_harness_models("codex")
check("codex model catalog is honest about having no listing command",
      codex_models, [{"value": "", "label": "Default"}])

orig_run = heartbeat.subprocess.run
try:
    class FakeProc:
        stdout = json.dumps({"models": [
            {"kind": "chat", "provider": "anthropic", "id": "claude-sonnet-5", "selector": "anthropic/claude-sonnet-5", "name": "Sonnet 5"},
            {"kind": "embedding", "provider": "openai", "selector": "openai/text-embed"},
        ]})
    heartbeat.subprocess.run = lambda *a, **k: FakeProc()
    heartbeat._model_cache.pop("omp", None)
    omp_models = heartbeat.get_harness_models("omp")
    check("omp model catalog asks `omp models --json` and skips non-chat kinds",
          omp_models, [
              {"value": "", "label": "Default"},
              {"value": "anthropic/claude-sonnet-5", "label": "Sonnet 5 (anthropic)"},
          ])
finally:
    heartbeat.subprocess.run = orig_run
    heartbeat._model_cache.pop("omp", None)
# ---------------------------------------------------------------------------

if failures:
    print("\n".join(failures))
    print(f"\n{len(failures)} failed")
    sys.exit(1)
print("all gateway tests passed")
