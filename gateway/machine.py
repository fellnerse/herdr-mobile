"""What the machine the agents run on has left.

The usage strip says what the subscription has left. This says what the laptop
has left, which is the other half of the same question: an agent that is slow
because six of them are compiling at once looks exactly like an agent that is
slow because the window is nearly gone, and only one of those is worth waiting
out.

Five numbers: cpu, memory, swap, disk and network. Three of them are rates, and
a rate is a difference between two readings - so all the counters are read
together, in one pass, against one previous pass. Sampling each separately
would mean several sleeps per poll and several spans that do not line up.

Standard library only, like the rest of the gateway, which rules out psutil:
Linux is read out of `/proc`, macOS out of the tools that ship with it. A
reading nobody can take is not an error worth a failed page - `snapshot`
answers `ok: False`, a part of it nobody can take is `None`, and the phone
draws the bar empty rather than dropping the line.
"""

from __future__ import annotations

import os
import platform
import re
import subprocess
import threading
import time

# A rate is a difference between two readings, so the first one has nothing to
# subtract from. Rather than answer nothing, take the second reading here - a
# tenth of a second, once, inside a poll the phone makes every thirty. It is a
# coarse sample for the first paint; every poll after it spans the real gap.
FIRST_SAMPLE_S = 0.1

# Two readings far enough apart describe an average over minutes, which is not
# what "how loaded is this machine right now" is asking. Past this, start over.
MAX_SPAN_S = 90.0

# And two readings close enough together describe nothing at all: the counters
# tick in jiffies, so anything under this samples afresh instead.
MIN_SPAN_S = 0.5

# /proc/diskstats counts in sectors, and always in 512-byte ones whatever the
# drive's own sector size is.
SECTOR = 512

# Block devices that are a view of another block device. Counting device-mapper
# or RAID as well as the disk underneath reports every write two or three times
# - on this machine dm-3, dm-4 and sda3 are the same bytes, three times over.
VIRTUAL_DISKS = ("loop", "ram", "zram", "dm-", "md", "sr", "fd")

# The same argument for interfaces. Tailscale traffic leaves through eth0 as
# well, wrapped, and a container's veth is its host's bridge seen twice.
VIRTUAL_IFACES = ("lo", "veth", "docker", "br-", "virbr", "tailscale", "tun",
                  "tap", "wg", "zt", "utun", "bridge", "awdl", "llw", "gif",
                  "stf", "ap", "anpi")

# The last pass of the counters: (monotonic, readings). The gateway serves
# requests on threads, so two polls can land at once on one set of counters.
_last = None
_lock = threading.Lock()


def snapshot() -> dict:
    """Load, memory, swap, disk and network, shaped for the strip above the flock."""
    try:
        moved = sample()
        total, used = memory()
        return {
            "ok": True,
            "host": platform.node().split(".")[0],
            "cores": os.cpu_count() or 1,
            "cpu": moved["cpu"],
            "load": load_average(),
            "memory": _share(total, used),
            "swap": _share(*swap()),
            "disk": moved["disk"],
            "net": moved["net"],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _share(total, used):
    """A bar's worth of a total: nothing at all where there is no such thing.

    A machine with swap turned off has no swap line rather than an empty one -
    0% of nothing is not a fact about the machine.
    """
    if not total:
        return None
    return {"total": total, "used": used, "percent": 100.0 * used / total}


def load_average():
    """The one-minute load average, or nothing where there is no such thing."""
    try:
        return os.getloadavg()[0]
    except (OSError, AttributeError):
        return None


# ------------------------------------------------------------------ rates ---


def sample() -> dict:
    """Everything that is a rate, against the last time anybody asked.

    The previous pass is kept for the next caller, so a phone polling every
    thirty seconds gets an average over those thirty seconds rather than over
    an arbitrary sleep - which is the honest shape of "how busy is this
    machine", and costs nothing.
    """
    global _last
    with _lock:
        now, counters = time.monotonic(), read_counters()
        previous = _last
        if not (previous and MIN_SPAN_S <= now - previous[0] <= MAX_SPAN_S):
            # Nothing to subtract from, or nothing worth subtracting from.
            previous = (now, counters)
            time.sleep(FIRST_SAMPLE_S)
            now, counters = time.monotonic(), read_counters()
        _last = (now, counters)
        span = now - previous[0]
    return rates(previous[1], counters, span)


def read_counters() -> dict:
    """Every ticking counter this machine will show us, in one pass."""
    return {
        "cpu": _read(lambda: parse_proc_stat(_slurp("/proc/stat")), "/proc/stat"),
        "disk": _read(lambda: parse_diskstats(_slurp("/proc/diskstats"), whole_disks()),
                      "/proc/diskstats"),
        "net": _read(_net_counter, None),
    }


def rates(before: dict, after: dict, span: float) -> dict:
    """What moved between two passes, per second - and percent for the CPU."""
    return {
        "cpu": cpu_delta(before["cpu"], after["cpu"]) if _both("cpu", before, after)
               else _cpu_percent_fallback(),
        "disk": _flow(before["disk"], after["disk"], span, ("read", "write")),
        "net": _flow(before["net"], after["net"], span, ("rx", "tx")),
    }


def _both(key, before, after) -> bool:
    return before.get(key) is not None and after.get(key) is not None


def _flow(before, after, span, names):
    """Two counters over a span, as bytes a second.

    A counter that went backwards is a machine that rebooted or a device that
    went away mid-span, not a negative throughput: it reads as nothing moving
    rather than as a number nobody can interpret.
    """
    if before is None or after is None or span <= 0:
        return None
    moved = [max(0, a - b) / span for b, a in zip(before, after)]
    return dict(zip(names, moved))


def cpu_delta(before, after):
    """The percentage between two (busy, total) readings, or None.

    None where the counters did not move: on an idle machine sampled twice
    inside one jiffy the honest answer is "ask again", not 0%.
    """
    span = after[1] - before[1]
    if span <= 0:
        return None
    return max(0.0, min(100.0, 100.0 * (after[0] - before[0]) / span))


# ------------------------------------------------------------------- Linux ---


def parse_proc_stat(text: str):
    """(busy, total) jiffies from the aggregate line of /proc/stat.

    The first line is every core added together; the per-core lines below it
    are not what a single number wants. Fields past `steal` are guest time,
    which the kernel has already counted inside `user` and `nice`, so adding
    them would charge a virtual machine twice. Busy is everything that is not
    idle and not waiting on a disk - a build blocked on IO is not what makes an
    agent's pane crawl, and counting it turns every build into 100%.
    """
    for line in text.splitlines():
        if not line.startswith("cpu "):
            continue
        fields = [int(v) for v in line.split()[1:9]]
        if len(fields) < 5:
            break
        total = sum(fields)
        idle = fields[3] + fields[4]  # idle + iowait
        return total - idle, total
    raise ValueError("no aggregate cpu line in /proc/stat")


def parse_diskstats(text: str, devices):
    """(bytes read, bytes written) since boot, over the given devices.

    Fields are the kernel's, counted from the device name: reads, merges,
    sectors read, ms, then writes, merges, sectors written.
    """
    read = written = 0
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 10 or fields[2] not in devices:
            continue
        read += int(fields[5]) * SECTOR
        written += int(fields[9]) * SECTOR
    return read, written


def whole_disks() -> set:
    """The real drives: no partitions, no views of another drive.

    `/sys/block` lists whole devices only, which is what keeps sda1 from being
    counted on top of sda. What it does list and we do not want is everything
    layered over a disk rather than being one.
    """
    names = set(os.listdir("/sys/block"))
    return {n for n in names if not n.startswith(VIRTUAL_DISKS)}


def parse_net_dev(text: str):
    """(bytes in, bytes out) since boot, over the interfaces that are wires.

    Every line is `iface: rx_bytes ... tx_bytes ...`, and the interfaces left
    out are the ones whose traffic is counted again somewhere else.
    """
    rx = tx = 0
    for line in text.splitlines():
        if ":" not in line:
            continue
        name, _, rest = line.partition(":")
        name = name.strip()
        fields = rest.split()
        if len(fields) < 9 or name.startswith(VIRTUAL_IFACES):
            continue
        rx += int(fields[0])
        tx += int(fields[8])
    return rx, tx


def parse_meminfo(text: str):
    """(total, used) bytes from /proc/meminfo.

    Used is what is not *available*, not what is not free: Linux spends every
    spare page on cache and hands it back the moment something wants it, so
    MemFree on a healthy machine reads as a machine about to die.
    """
    values = _meminfo_values(text)
    total = values.get("MemTotal")
    if not total:
        raise ValueError("no MemTotal in /proc/meminfo")
    available = values.get("MemAvailable")
    if available is None:
        available = (values.get("MemFree", 0) + values.get("Cached", 0)
                     + values.get("Buffers", 0))
    return total, max(0, total - available)


def parse_swapinfo(text: str):
    """(total, used) swap bytes from the same file.

    Swap has no cache argument to make: what is not free is in use, and a
    machine that is swapping is a machine that is already hurting.
    """
    values = _meminfo_values(text)
    total = values.get("SwapTotal", 0)
    if not total:
        return 0, 0
    return total, max(0, total - values.get("SwapFree", 0))


def _meminfo_values(text: str) -> dict:
    return {m.group(1): int(m.group(2)) * 1024
            for m in re.finditer(r"^(\w+):\s+(\d+)\s*kB", text, re.M)}


# ------------------------------------------------------------------- macOS ---


def parse_vm_stat(text: str, total: int):
    """(total, used) bytes from `vm_stat` output.

    Used is what Activity Monitor calls memory pressure's numerator: pages held
    by something running (active), pages that cannot be paged out (wired) and
    pages squeezed into the compressor. Inactive and speculative pages are
    cache, the same argument as MemAvailable above.
    """
    page = 4096
    m = re.search(r"page size of (\d+) bytes", text)
    if m:
        page = int(m.group(1))
    counts = dict(re.findall(r"^(.+?):\s+(\d+)\.", text, re.M))

    def pages(name):
        return int(counts.get(name, 0))

    used = (pages("Pages active") + pages("Pages wired down")
            + pages("Pages occupied by compressor")) * page
    return total, min(total, used) if total else used


def parse_swapusage(text: str):
    """(total, used) bytes from `sysctl vm.swapusage`.

    It answers in megabytes with an M stuck to the number, and on a Mac that
    has not swapped yet the total is a file macOS has not grown yet - which is
    0, and no line.
    """
    values = dict(re.findall(r"(\w+) = ([\d.]+)M", text))
    if not values.get("total"):
        return 0, 0
    mb = 1024 * 1024
    return int(float(values["total"]) * mb), int(float(values.get("used", 0)) * mb)


def parse_netstat_ib(text: str):
    """(bytes in, bytes out) from `netstat -ib`.

    macOS prints a row per interface *per address*, all carrying the same
    interface-wide totals, so the rows are collapsed by name rather than added
    up - adding them counts a Wi-Fi card once for IPv4 and again for IPv6.

    The columns are found from the right rather than from the left, because a
    row for an interface with no address is one field short and every index
    counted from the front is then off by one.
    """
    lines = text.splitlines()
    header = lines[0].split() if lines else []
    if "Ibytes" not in header or "Obytes" not in header:
        raise ValueError("netstat -ib has no byte columns")
    rx_at = header.index("Ibytes") - len(header)
    tx_at = header.index("Obytes") - len(header)
    seen = {}
    for line in lines[1:]:
        fields = line.split()
        if len(fields) < -rx_at or fields[0].startswith(VIRTUAL_IFACES):
            continue
        try:  # an address row carries "-" where the packet counts would be
            seen[fields[0]] = (int(fields[rx_at]), int(fields[tx_at]))
        except ValueError:
            continue
    return (sum(v[0] for v in seen.values()), sum(v[1] for v in seen.values()))


def _cpu_percent_fallback():
    """macOS and friends: what every process says it is using, added up.

    `ps` reports a decaying average per process rather than an instant, so this
    lags a sudden spike by a few seconds. It is one cheap call, it needs no
    sampling window, and it is right about the thing being asked - whether the
    machine is buried.
    """
    try:
        out = _run(["ps", "-A", "-o", "%cpu="])
    except Exception:
        return None
    used = sum(float(v) for v in out.split() if _is_number(v))
    return max(0.0, min(100.0, used / (os.cpu_count() or 1)))


# ------------------------------------------------------- whichever this is ---


def memory():
    """(total, used) bytes."""
    if os.path.exists("/proc/meminfo"):
        return parse_meminfo(_slurp("/proc/meminfo"))
    total = int(_run(["sysctl", "-n", "hw.memsize"]).strip() or 0)
    return parse_vm_stat(_run(["vm_stat"]), total)


def swap():
    """(total, used) swap bytes, and (0, 0) where there is no swap."""
    try:
        if os.path.exists("/proc/meminfo"):
            return parse_swapinfo(_slurp("/proc/meminfo"))
        return parse_swapusage(_run(["sysctl", "-n", "vm.swapusage"]))
    except Exception:
        return 0, 0


def _net_counter():
    if os.path.exists("/proc/net/dev"):
        return parse_net_dev(_slurp("/proc/net/dev"))
    return parse_netstat_ib(_run(["netstat", "-ib"]))


def _read(take, path):
    """One counter, or None where this machine does not keep it."""
    if path and not os.path.exists(path):
        return None
    try:
        return take()
    except Exception:
        return None


def _slurp(path: str) -> str:
    with open(path, "r") as fh:
        return fh.read()


def _run(cmd) -> str:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          timeout=5, check=True).stdout.decode("utf-8", "replace")


def _is_number(value: str) -> bool:
    try:
        float(value)
        return True
    except ValueError:
        return False
