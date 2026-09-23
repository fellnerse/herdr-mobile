"""What an agent changed, read straight out of git.

An agent working on its own leaves the answer in the working tree, and the
question the phone actually asks is "what did it touch?". This module answers
it the way herdr-studio's `server/src/workspace/git-diff.ts` does (MIT, (c)
2026 Arthur - see LICENSES/HERDR-STUDIO.txt): plain git plumbing run in the
pane's own directory. Its remote/ssh paths and its last-step snapshots are not
ported; this gateway only ever looks at a directory on this machine.

Two things the porcelain gets right that are worth stating:

* `-z` output is NUL-separated and unquoted, so paths with spaces, quotes or
  newlines arrive whole. The C-style unquoting the text format needs simply
  does not apply.
* Untracked files have no diff to ask git for, so they are counted and
  rendered against an empty file instead.
"""

import os
import subprocess
from pathlib import Path

# Git is being asked about a working tree, not a history: these finish fast or
# something is wrong. A repository on a slow disk gets the longer read.
STATUS_TIMEOUT = 10
DIFF_TIMEOUT = 20
# One file's diff, past which the phone is not the right place to read it.
MAX_DIFF_BYTES = 512 * 1024
# An untracked file is counted by reading it; a huge one is not worth the read.
MAX_COUNT_BYTES = 2 * 1024 * 1024

# What the phone can look at as a picture rather than as a patch. The
# extension decides, because the browser is the thing that has to recognise
# the bytes; git has already said the file is binary. SVG is deliberately not
# here - it is text, and its diff is worth reading.
IMAGE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".avif": "image/avif",
}

# One image, past which a phone screen is not where it wants to be looked at.
MAX_IMAGE_BYTES = 8 * 1024 * 1024


class GitError(Exception):
    pass


def run_git(root: str, args: list, timeout: int = STATUS_TIMEOUT) -> str:
    """Run one git command in `root`, as text."""
    return run_git_bytes(root, args, timeout).decode("utf-8", errors="replace")


def run_git_bytes(root: str, args: list, timeout: int = STATUS_TIMEOUT) -> bytes:
    """Run one git command in `root`, as the bytes it wrote. List argv, no
    shell: nothing here is interpolated into a command line, so a path cannot
    become an argument. Raw, because `git show` on an image is a PNG and
    decoding it would be the one thing that must not happen to it."""
    try:
        proc = subprocess.run(
            ["git", "-C", root, "-c", "core.quotepath=false"] + args,
            capture_output=True, timeout=timeout, check=False,
        )
    except FileNotFoundError:
        raise GitError("git is not installed")
    except subprocess.TimeoutExpired:
        raise GitError("git took too long")
    # `diff --no-index` exits 1 when the files differ, which is the normal
    # case and not a failure.
    if proc.returncode not in (0, 1):
        message = (proc.stderr or proc.stdout).decode("utf-8", errors="replace")
        raise GitError(message.strip().split("\n")[0] or f"git exited {proc.returncode}")
    return proc.stdout


def repo_root(cwd: str) -> str:
    """The working tree `cwd` sits in, or "" when it is not in one."""
    if not cwd or not os.path.isdir(cwd):
        return ""
    try:
        out = run_git(cwd, ["rev-parse", "--show-toplevel"])
    except GitError:
        return ""
    return out.strip()


def is_repo_root(path: str) -> bool:
    """Whether `path` is the top of a working tree, and not merely inside one.

    The phone only ever names a root this gateway handed it, and this is what
    makes that true rather than assumed - the same reason `safe_path` exists.

    Both sides are resolved before comparing: `--show-toplevel` reports a real
    path, and on macOS the directory a checkout is in is reached through a
    symlink often enough that comparing the strings says no to a real root.
    """
    if not path or not os.path.isdir(path):
        return False
    top = repo_root(path)
    return bool(top) and os.path.realpath(top) == os.path.realpath(path)


def delete_branch(root: str, branch: str, force: bool = False) -> None:
    """Delete a local branch, raising with git's own words if it refuses.

    `-d` unless forced: git refuses a branch whose commits are not merged
    anywhere else, which is the difference between tidying up after a worktree
    and throwing away the work that was done in it. `run_git` is not used here
    because it treats exit 1 as success for `diff --no-index`, and exit 1 is
    exactly how that refusal arrives.
    """
    if not branch or branch.startswith("-") or "\x00" in branch:
        raise GitError("bad branch name")
    try:
        proc = subprocess.run(
            ["git", "-C", root, "branch", "-D" if force else "-d", "--", branch],
            capture_output=True, timeout=STATUS_TIMEOUT, check=False,
        )
    except FileNotFoundError:
        raise GitError("git is not installed")
    except subprocess.TimeoutExpired:
        raise GitError("git took too long")
    if proc.returncode != 0:
        message = (proc.stderr or proc.stdout).decode("utf-8", errors="replace")
        raise GitError(message.strip().split("\n")[0] or f"git exited {proc.returncode}")


def safe_path(root: str, rel: str) -> str:
    """A path the client named, resolved back inside the repository.

    The phone only ever names a path this gateway handed it, but the check is
    what makes that true rather than assumed: a rooted or climbing path is
    refused instead of read."""
    if not rel or rel.startswith("/") or "\x00" in rel:
        raise GitError("bad path")
    target = (Path(root) / rel).resolve()
    if not target.is_relative_to(Path(root).resolve()):
        raise GitError("path outside the repository")
    return str(target)


def image_type(rel_path: str) -> str:
    """The media type the browser would draw this path with, or "" for
    anything that is not a picture."""
    return IMAGE_TYPES.get(os.path.splitext(rel_path)[1].lower(), "")


def image_blob(cwd: str, rel_path: str, side: str = "work") -> tuple:
    """One image and its type: `work` is the file as it is on disk now,
    `head` is what it was at the last commit.

    The two sides are what makes a picture readable as a change at all - a
    patch for a PNG says "Binary files differ" and stops there.
    """
    root = repo_root(cwd)
    if not root:
        raise GitError("not a git repository")
    # Checked the same way the patch route checks it, before either side of
    # it is read: the phone names the path, so the phone could name any path.
    target = safe_path(root, rel_path)
    mime = image_type(rel_path)
    if not mime:
        raise GitError("not an image")
    if side == "head":
        # `HEAD:path` rather than a working-tree read: a file that was deleted
        # or replaced still has a before, and this is where it lives. git
        # exits 128 when HEAD has no such file, which `run_git_bytes` raises.
        data = run_git_bytes(root, ["show", "HEAD:" + rel_path], DIFF_TIMEOUT)
    else:
        try:
            with open(target, "rb") as f:
                data = f.read(MAX_IMAGE_BYTES + 1)
        except OSError:
            raise GitError("could not read that file")
    if len(data) > MAX_IMAGE_BYTES:
        raise GitError("that image is too big to show")
    return data, mime


def _split_z(out: str) -> list:
    return [entry for entry in out.split("\0") if entry]


def _numstat(root: str) -> dict:
    """Added/removed line counts per path, for everything git tracks."""
    counts = {}
    out = run_git(root, ["diff", "--numstat", "-z", "HEAD"], DIFF_TIMEOUT)
    # Each record is "added TAB removed TAB path NUL". A rename leaves the
    # path empty and spells its two names as the next two fields instead.
    fields = out.split("\0")
    i = 0
    while i < len(fields):
        record = fields[i]
        i += 1
        if not record:
            continue
        parts = record.split("\t")
        if len(parts) < 3:
            continue
        added, removed, path = parts[0], parts[1], parts[2]
        if path == "" and i + 1 < len(fields):
            old_path, path = fields[i], fields[i + 1]
            i += 2
            counts[old_path] = {"added": 0, "removed": 0, "binary": False}
        # "-" where a number should be is git saying the file is binary.
        binary = added == "-" or removed == "-"
        counts[path] = {
            "added": 0 if binary else int(added or 0),
            "removed": 0 if binary else int(removed or 0),
            "binary": binary,
        }
    return counts


def _count_untracked(path: str) -> dict:
    """An untracked file is all addition; count its lines, unless it is
    binary or big enough that counting is the wrong thing to do."""
    try:
        size = os.path.getsize(path)
        if size > MAX_COUNT_BYTES:
            return {"added": 0, "removed": 0, "binary": False, "large": True}
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return {"added": 0, "removed": 0, "binary": False}
    if b"\0" in data[:8000]:
        return {"added": 0, "removed": 0, "binary": True}
    if not data:
        return {"added": 0, "removed": 0, "binary": False}
    return {
        "added": data.count(b"\n") + (0 if data.endswith(b"\n") else 1),
        "removed": 0,
        "binary": False,
    }


def changed_files(cwd: str) -> dict:
    """Every file the working tree differs from HEAD by, newest state first.

    Status letters are git's own: the index column and the worktree column,
    with "??" for untracked. Both are kept, because "staged and then edited
    again" is a real thing an agent does and the phone should not flatten it.
    """
    root = repo_root(cwd)
    if not root:
        return {"repo": False, "root": "", "files": [], "branch": ""}

    branch = run_git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).strip()
    entries = _split_z(run_git(root, ["status", "--porcelain=v1", "-z", "-uall"]))
    counts = _numstat(root)

    files = []
    skip_next = False
    for i, entry in enumerate(entries):
        if skip_next:
            skip_next = False
            continue
        if len(entry) < 4:
            continue
        index_status, worktree_status, path = entry[0], entry[1], entry[3:]
        old_path = ""
        if index_status in ("R", "C"):
            # A rename's source is the field after it.
            old_path = entries[i + 1] if i + 1 < len(entries) else ""
            skip_next = True
        untracked = index_status == "?" and worktree_status == "?"
        stat = (_count_untracked(os.path.join(root, path)) if untracked
                else counts.get(path, {"added": 0, "removed": 0, "binary": False}))
        files.append({
            "path": path,
            "old_path": old_path,
            "index_status": index_status.strip(),
            "worktree_status": worktree_status.strip(),
            "untracked": untracked,
            "added": stat.get("added", 0),
            "removed": stat.get("removed", 0),
            "binary": stat.get("binary", False),
            "large": stat.get("large", False),
            # Not "is it binary" but "can it be shown": what the phone draws
            # in place of a patch it cannot read.
            "image": image_type(path),
        })

    files.sort(key=lambda f: (-(f["added"] + f["removed"]), f["path"]))
    return {
        "repo": True,
        "root": root,
        "branch": branch,
        "files": files,
        "added": sum(f["added"] for f in files),
        "removed": sum(f["removed"] for f in files),
    }


def file_diff(cwd: str, rel_path: str) -> dict:
    """One file's unified diff against HEAD, or against nothing if it is new."""
    root = repo_root(cwd)
    if not root:
        raise GitError("not a git repository")
    # Validated, then discarded: git is given the relative path so the diff
    # headers read like every other diff, not like this machine's disk.
    safe_path(root, rel_path)

    tracked = run_git(root, ["ls-files", "--error-unmatch", "-z", "--", rel_path]).strip()
    if tracked:
        patch = run_git(root, ["diff", "--no-color", "HEAD", "--", rel_path], DIFF_TIMEOUT)
    else:
        # No index entry, so there is nothing to diff against but an empty
        # file. --no-index makes git do exactly that, and exits 1 doing it.
        # It also numbers its prefixes 1/ and 2/ rather than a/ and b/, so
        # they are named explicitly and every patch reads the same way.
        patch = run_git(root, ["diff", "--no-color", "--no-index",
                               "--src-prefix=a/", "--dst-prefix=b/", "--",
                               os.devnull, rel_path], DIFF_TIMEOUT)

    truncated = len(patch.encode("utf-8", errors="replace")) > MAX_DIFF_BYTES
    if truncated:
        patch = patch.encode("utf-8")[:MAX_DIFF_BYTES].decode("utf-8", errors="ignore")
    return {
        "path": rel_path,
        "tracked": bool(tracked),
        "patch": patch,
        "truncated": truncated,
    }
