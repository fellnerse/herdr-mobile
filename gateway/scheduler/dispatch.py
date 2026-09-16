"""Delivering queued prompts into live chat sessions, as quota allows.

The queue holds prompts for panes you already have open. Nothing is
provisioned: no worktree, no branch, no agent launch, and so no folder-trust
dialog to get stuck on. A prompt is delivered when its pane is free and the
subscription has room, and held when it does not.
"""

from __future__ import annotations

import logging
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone

import push
from herdr_rpc import Events, Herdr, HerdrError

from . import STATE_DIR, db, quota
from .config import Config

log = logging.getLogger("scheduler")

# Claude Code prints its own wall message before going idle. Catching it in the
# pane is more reliable than inferring exhaustion from a utilization number that
# may lag by up to a poll interval.
LIMIT_RE = re.compile(
    r"(usage limit reached|limit reached|out of (?:usage|credits)|"
    r"limit will reset|upgrade to increase your usage limit|"
    # The current wording: "You've hit your session limit · resets 12:50pm
    # (UTC)", and the menu it opens underneath it.
    r"hit your (?:\w+ )?limit|limit to reset|rate-limit-options)",
    re.IGNORECASE,
)

# The same pattern for Herdr, which matches it server-side and knows nothing
# about Python's flags: the case-insensitivity has to travel inside the string.
LIMIT_PATTERN = f"(?i){LIMIT_RE.pattern}"

RESUME_PROMPT = (
    "Your previous turn was interrupted because the usage window ran out. "
    "The window has reset. Continue exactly where you left off."
)

# An agent in one of these is listening and free. `blocked` is deliberately not
# here: it is sitting on a question, and text sent now would answer it.
READY = ("idle", "done")

# Claude Code no longer only prints the wall and stops: it opens
# `/rate-limit-options` and waits on a menu. A pane sitting on that menu is
# `blocked`, so the queue reports it and goes no further -- at 4am, over a
# question whose answer is always the same one.
#
# "❯ 1. Stop and wait for limit to reset", the same shape the phone parses.
MENU_OPTION_RE = re.compile(r"^\s*([❯›>])?\s*(\d{1,2})\.\s+(\S.*?)\s*$")
# The only option this is ever allowed to press. Waiting is what the stall does
# anyway, so answering with it changes nothing except that the pane is free
# afterwards; anything else spends money or picks a plan. Claude Code shortens
# the label to a bare "Stop" in some states and puts it last rather than first
# in others, which is why the option is found by what it says and never by
# where it sits. The rest of that menu is "Upgrade your plan" and "Upgrade to
# Team plan": nothing this may press on somebody's behalf at 4am.
WAIT_OPTION_RE = re.compile(r"stop and wait|wait for (?:the )?limit|^stop$", re.IGNORECASE)


# Claude Code opens the menu by typing the command into its own composer, so
# "❯ /rate-limit-options" is sitting above the box while the question is up. If
# answering leaves it there, the resume -- delivered hours later, as text
# appended to whatever the composer already holds -- is submitted as an argument
# to a slash command and swallowed whole. That is the exact way a queued prompt
# disappears without failing, and the queue would report it as sent.
LEFTOVER_COMMAND_RE = re.compile(r"^\s*[❯›>]\s*/rate-limit-options\b", re.MULTILINE)


def keep_the_screen(pane_id: str, text: str) -> None:
    """Write down the screen the wall acted on.

    The limit arrives once every few days, at whatever hour it likes, and the
    screen it drew is gone by morning -- so when this gets it wrong the only
    evidence is somebody's memory of a screenshot. Kept whether it worked or
    not, because a hold that was right looks identical to one that was missed.
    Replay it with `sheepit-queue wall --screen`.
    """
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = STATE_DIR / f"wall-{pane_id.replace(':', '-')}-{stamp}.txt"
        path.write_text(text)
        log.info("kept the screen the wall acted on: %s", path)
    except OSError as e:
        log.warning("could not keep the wall screen for %s: %s", pane_id, e)


def wall_menu(text: str):
    """The menu on screen: its options, the one under the cursor, the one that
    says to wait. Any of the last two may be None, and usually the list is empty.

    The numbering has to run 1, 2, 3 with nothing missing, and a fresh `1.`
    starts the list over -- which is what keeps an ordinary numbered list
    further up the scrollback from being read as a question somebody is being
    asked. `sheepit-queue wall` prints what this saw, so it is the same parse
    being checked as the one that acts.
    """
    options, selected, wanted = [], None, None
    for line in text.splitlines():
        m = MENU_OPTION_RE.match(line)
        if not m:
            continue
        cursor, number, label = m.group(1), int(m.group(2)), m.group(3)
        if number == 1:
            options, selected, wanted = [], None, None  # a menu starts here
        elif number != len(options) + 1:
            continue
        if cursor:
            selected = len(options)
        if WAIT_OPTION_RE.search(label):
            wanted = len(options)
        options.append(label)
    return options, selected, wanted


def wall_menu_keys(text: str):
    """The keys that answer the rate-limit menu, or None if there is none to answer.

    Walked to with arrows rather than typed as a number, and chosen by what the
    option says rather than where it sits: a menu whose options were reordered
    must still answer "wait", and one with no such option is left for a person.
    """
    _, selected, wanted = wall_menu(text)
    if wanted is None or selected is None:
        return None
    step = wanted - selected
    return ["down"] * step + ["up"] * -step + ["enter"]

# Output matching is evaluated against a window of recent output, so subscribing
# to a pane that already has an old wall message on screen fires immediately.
# Matches this soon after subscribing describe the past, not a fresh wall.
SUBSCRIBE_GRACE = 3.0

# How long to sit out after hitting the wall when quota cannot say when the
# window reopens -- long enough not to spin, short enough to notice a reset.
BLIND_STALL = 300.0


def _push(reason: str) -> None:
    """Wake the phone. Payload-less by design, same as the gateway's own pushes."""
    if not push.load_subs():
        return
    try:
        push.broadcast()
    except Exception as e:
        log.warning("push failed (%s): %s", reason, e)


def subscriptions(pane_ids: list[str]) -> list:
    """What to watch, given the panes worth watching.

    Two questions per pane: has the agent freed up, and has it hit the wall.
    `pane.closed` is global and needs no pane, and is what starts cold recovery.
    """
    subs = [{"type": "pane.closed"}]
    for pane_id in pane_ids:
        subs.append({"type": "pane.agent_status_changed", "pane_id": pane_id})
        subs.append({
            "type": "pane.output_matched",
            "pane_id": pane_id,
            "source": "recent_unwrapped",
            "match": {"type": "regex", "value": LIMIT_PATTERN},
            "lines": 60,
        })
    return subs


class Dispatcher:
    """Delivers queued prompts. One instance owns the stalls and the stream."""

    def __init__(self, herdr: Herdr = None, events: Events = None):
        self.herdr = herdr or Herdr()
        self.events = events or Events()
        # pane_id -> monotonic deadline. In memory on purpose: a restart that
        # forgets a stall costs one redelivery, which hits the wall again and
        # re-stalls, and that is cheaper than persisting a guess.
        self.stalls: dict[str, float] = {}
        # Panes we have already said something about, so a pane that is stuck
        # is reported once rather than on every pass. Cleared the moment it is
        # free again, which is what makes the next episode audible.
        self.reported: set[str] = set()
        # Panes that were mid-turn when the banner appeared, to be looked at
        # again. Matching is edge-triggered on output, and a turn that dies at
        # the limit stops producing any -- so the one event that ever arrives
        # is the one that finds the pane still working, and nothing comes back
        # to it. Cost of not having this, measured: a chat sat under its banner
        # from 10:02 until 15:04, when a person noticed.
        self.pending: set[str] = set()
        # Panes whose screen has already been kept, so one looked at every
        # minute leaves one file behind rather than a hundred.
        self.kept: set[str] = set()

    # --- delivery ------------------------------------------------------

    def sweep(self, conn: sqlite3.Connection, cfg: Config) -> None:
        """Deliver one prompt to every pane that can take one.

        One at a time per pane: what is waiting behind the first prompt should
        be read by an agent that has finished the one in front of it, not
        stacked into a session all at once.

        A prompt somebody typed is theirs to spend their own window on, down to
        the last percent: a queue that stops at 85% stops exactly when it is
        most wanted, and the 15% it was protecting is days of perfectly good
        weekly window. But "down to the last percent" has an end, and this is
        it. A window with nothing left in it cannot take the prompt - handing
        it over would spend it against a wall and lose the text in a refusal -
        so a pane whose agent is out waits for the window to reopen.
        """
        ready = {}
        for pane_id in db.waiting_panes(conn):
            self.herdr.report_queued(pane_id, db.count_waiting(conn, pane_id))
            # A stalled pane is not asked about at all: it is waiting out a
            # window, and nothing we could learn about it changes that.
            if self.stalls.get(pane_id, 0.0) > time.monotonic():
                continue

            status = self.herdr.status(pane_id)
            if status in ("gone", "no-agent"):
                self.recover(conn, pane_id, status, cfg)
                continue
            if status == "blocked":
                self.report_blocked(conn, pane_id)
                continue
            self.reported.discard(pane_id)
            if status in READY:
                # Grouped by the agent in the pane: a Claude window says
                # nothing about what a Codex pane may spend, and holding one on
                # the other's wall is how a working agent ends up waiting for a
                # limit that was never its own.
                ready.setdefault(self.herdr.agent_kind(pane_id) or "", []).append(pane_id)

        for agent, panes in ready.items():
            if self.out_of_window(agent, panes):
                continue
            for pane_id in panes:
                if (prompt := db.next_for_pane(conn, pane_id)) is not None:
                    self.deliver(conn, prompt)

    def out_of_window(self, agent: str, panes: list) -> bool:
        """Whether this agent has nothing left to spend.

        Only a window that is actually out holds anything - not `threshold`,
        which is a colour on a bar, and not a reading nobody could take. Not
        knowing is not the same as knowing there is nothing left, and a hold is
        forever: nothing retries a prompt the sweep declined to send, so an
        agent that cannot be priced is delivered to and the wall detection
        catches it if that was optimistic.
        """
        try:
            current = quota.current(agent)
        except quota.QuotaError as e:
            log.info("no usage reading for %s, delivering anyway: %s", agent or "?", e)
            return False
        if spent := current.spent():
            names = ", ".join(f"{b.name} {b.utilization:.0f}%" for b in spent)
            log.info("holding %d %s pane(s): %s; back at %s",
                     len(panes), agent or "?", names, current.resume_at() or "the next reset")
            return True
        return False

    def report_blocked(self, conn: sqlite3.Connection, pane_id: str) -> None:
        """Say that a pane has stopped on a question with work stacked behind it.

        The point of the whole queue is that you do not have to watch it. That
        only holds if the one case it cannot get itself out of comes and finds
        you instead of waiting silently until morning.
        """
        if pane_id in self.reported:
            return
        self.reported.add(pane_id)
        waiting = db.count_waiting(conn, pane_id)
        self.herdr.notify(
            f"{pane_id} needs you", f"{waiting} prompt(s) waiting behind a question"
        )
        _push("blocked")
        log.info("pane %s is blocked with %d prompt(s) waiting", pane_id, waiting)

    def deliver(self, conn: sqlite3.Connection, prompt: db.Prompt, typed: bool = False) -> None:
        """Hand a prompt over: to the agent in the pane, or to the pane itself.

        `typed` is the shell case -- a pane with nothing running in it takes the
        text as keystrokes, because there is no agent to hand it to and waiting
        for one is how a prompt gets stuck for good.
        """
        try:
            if typed:
                self.herdr.send_line(prompt.pane_id, prompt.prompt)
            else:
                self.herdr.agent_prompt(prompt.pane_id, prompt.prompt)
        except HerdrError as e:
            db.update(conn, prompt.id, state="failed", last_error=str(e))
            log.warning("prompt %s could not be delivered: %s", prompt.id, e)
            _push("failed")
            return
        db.update(
            conn,
            prompt.id,
            state="sent",
            sent_at=db.now(),
            last_error=None,
            # Refresh the cold-recovery details from the session that actually
            # took it; what was captured at queue time may be a window old.
            session_uuid=self.herdr.session_uuid(prompt.pane_id) or prompt.session_uuid,
        )
        remaining = db.count_waiting(conn, prompt.pane_id)
        self.herdr.report_queued(prompt.pane_id, remaining)
        log.info("delivered prompt %s to %s (%d left)", prompt.id, prompt.pane_id, remaining)
        if not remaining:
            _push("queue empty")

    # --- the wall ------------------------------------------------------

    def hit_the_wall(self, conn: sqlite3.Connection, pane_id: str, cfg: Config) -> None:
        """A pane ran out of window mid-turn.

        Halting the turn and queueing a resume in front of everything else is
        the whole recovery: the agent keeps its pane and its conversation, so
        picking up where it left off is just another prompt.

        The banner triggers this but does not decide it. Matching is done against
        a window of recent output, so the same banner fires again every time the
        pane redraws while it is still on screen -- and a chat that merely
        discusses usage limits matches too. Both would `esc` a healthy turn and
        park a chat that was fine. Usage itself is the authority; the banner is
        what makes us go and ask.
        """
        if self.stalls.get(pane_id, 0.0) > time.monotonic():
            return  # already parked; the banner simply stayed on screen

        # The screen is read first, because what is on it settles both of the
        # questions below. A menu asking what to do about the limit is not
        # scrollback and not a chat discussing usage: it is the agent itself,
        # stopped, saying it has run out.
        try:
            screen = self.herdr.pane_read(pane_id)
            keys = wall_menu_keys(screen)
            if pane_id not in self.kept:
                self.kept.add(pane_id)
                keep_the_screen(pane_id, screen)
        except HerdrError:
            keys = None

        # A pane still working has not been stopped by anything: whatever
        # matched is either older than the turn in progress or something the
        # chat is merely talking about, and `esc` on a healthy turn throws away
        # real work.
        #
        # But `working` is not to be trusted over a menu that is visibly
        # waiting for a keypress. Herdr reads `working` off the spinner in the
        # terminal title -- rule `osc_title_working`, priority 1100, above its
        # own `live_blocked_form` at 980 -- and Claude Code keeps that spinner
        # turning while a background shell runs. "1 shell still running" sits
        # directly above the question in the screen this was built from, so
        # believing `working` there is precisely how the menu goes unanswered
        # all night.
        if keys is None and self.herdr.status(pane_id) == "working":
            # Not a verdict, a postponement: the turn may be about to die of
            # the very thing that put this banner on screen, and the event that
            # would have said so is never coming.
            if pane_id not in self.pending:
                self.pending.add(pane_id)
                log.info("%s has the banner but is still working; will look again", pane_id)
            return
        self.pending.discard(pane_id)

        resume_at = None
        try:
            current = quota.current(self.herdr.agent_kind(pane_id) or "")
            if not current.spent() and keys is None:
                log.debug("limit banner on %s but the window is open; ignoring", pane_id)
                return
            resume_at = current.resume_at()
        except quota.QuotaError:
            pass  # nothing to check against; a stopped turn under the banner is the evidence

        self.answer(pane_id, keys)

        self.stalls[pane_id] = time.monotonic() + (
            max(0.0, (resume_at - datetime.now(timezone.utc)).total_seconds())
            if resume_at else BLIND_STALL
        )

        if not any(p.prompt == RESUME_PROMPT for p in db.list_prompts(conn, pane_id, "waiting")):
            try:
                agent = self.herdr.agents_by_pane().get(pane_id) or {}
            except HerdrError:
                agent = {}
            db.add(
                conn, pane_id, RESUME_PROMPT, head=True,
                # The same details the phone records when you queue by hand. A
                # resume that is going to sit until 4am has to survive whatever
                # happens to the pane between now and then, and without these
                # the cold path has nothing to put the conversation back from.
                workspace_id=agent.get("workspace_id"),
                session_uuid=(agent.get("agent_session") or {}).get("value"),
                cwd=agent.get("cwd"),
            )
        self.herdr.report_queued(pane_id, db.count_waiting(conn, pane_id))
        self.herdr.notify("usage window exhausted", f"{pane_id} will resume when it resets")
        _push("window exhausted")
        log.info("pane %s hit the wall; resuming at %s", pane_id, resume_at or "next check")

    def answer(self, pane_id: str, keys) -> None:
        """Let go of the halted turn, and leave the composer fit to type into.

        `esc` is what drops a turn that merely stopped; on the menu it would
        only cancel, so the menu is answered with its own keys instead. Either
        way the composer has to come back empty, because what goes in next is a
        resume prompt nobody will be watching arrive.

        Only ever cleared when the agent's own command is what is sitting
        there: a half-written sentence somebody left on the desktop is not this
        thread's to throw away.
        """
        try:
            self.herdr.agent_send_keys(pane_id, keys or ["esc"])
        except HerdrError:
            return
        try:
            if LEFTOVER_COMMAND_RE.search(self.herdr.pane_read(pane_id)):
                self.herdr.agent_send_keys(pane_id, ["esc"])
                log.info("cleared the leftover command from %s's composer", pane_id)
        except HerdrError:
            pass

    # --- cold recovery -------------------------------------------------

    def recover(self, conn: sqlite3.Connection, pane_id: str, status: str, cfg: Config) -> None:
        """Put back a conversation whose agent did not survive.

        Herdr sessions are detached, so closing the app or losing the phone
        costs nothing and this never runs. A reboot is what it is for: the pane
        is gone, but the session UUID still names the conversation, and
        `--resume` walks back into it with its history intact.
        """
        prompt = db.next_for_pane(conn, pane_id)
        if prompt is None:
            return

        if prompt.prompt == RESUME_PROMPT and not prompt.session_uuid:
            # A resume is an instruction to a conversation, and with no session
            # there is no conversation left for it to mean anything to. Typing
            # "continue where you left off" at a bare shell is the one outcome
            # worse than losing it, so it goes -- and whatever was queued behind
            # it, which was written by a person and still makes sense, stays.
            db.delete(conn, prompt.id)
            log.info("dropping the resume for %s: no session left to continue", pane_id)
            return

        if not prompt.session_uuid:
            # Nothing to resume into, but the pane is still there. It is a
            # shell, so the prompt is typed into it: holding for an agent that
            # was never in this pane is a wait that nothing ends.
            if status == "no-agent":
                log.info("pane %s has no agent; typing prompt %s into it", pane_id, prompt.id)
                self.deliver(conn, prompt, typed=True)
                return
            failed = db.fail_pane(conn, pane_id, "the chat closed before this could be delivered")
            log.warning("pane %s is gone with no session to resume; failed %d prompt(s)",
                        pane_id, failed)
            _push("failed")
            return

        try:
            # A pane that still exists gets its agent back where it stands;
            # only a vanished one needs somewhere new to live.
            if status == "no-agent":
                target = pane_id
            elif prompt.cwd:
                target = self.herdr.open_pane(
                    prompt.cwd, prompt.workspace_id, label="resumed"
                )
            else:
                failed = db.fail_pane(conn, pane_id, "the chat is gone and there is no cwd to reopen it in")
                log.warning("pane %s is gone with no cwd recorded; failed %d prompt(s)",
                            pane_id, failed)
                _push("failed")
                return
            self.herdr.agent_start(
                f"sheepit-{prompt.id}", target, kind=cfg.agent_kind,
                args=[*cfg.agent_args, "--resume", prompt.session_uuid],
            )
        except HerdrError as e:
            # Back off rather than retrying on every event: a revive that fails
            # after opening somewhere to live has already left a pane behind,
            # and a tight loop would leave one per pass.
            self.stalls[pane_id] = time.monotonic() + BLIND_STALL
            log.warning("could not revive %s, waiting before trying again: %s", pane_id, e)
            return

        if target != pane_id:
            conn.execute(
                "UPDATE queued_prompt SET pane_id=? WHERE pane_id=? AND state='waiting'",
                (target, pane_id),
            )
            conn.commit()
        self.stalls.pop(pane_id, None)
        log.info("revived %s as %s from session %s", pane_id, target, prompt.session_uuid)

    def look_again(self, conn: sqlite3.Connection, cfg: Config) -> None:
        """Come back to the panes that were mid-turn when the banner appeared.

        Everywhere else in this file the event stream is a latency
        optimisation, because the next sweep re-reads whatever it missed. This
        is the one state that is never re-read: `working` was true once, the
        turn then died of the limit, and a dead turn writes nothing for the
        subscription to match on. Cheap to run -- one read per pane, and only
        for panes that have already shown a banner.
        """
        for pane_id in list(self.pending):
            try:
                if not LIMIT_RE.search(self.herdr.pane_read(pane_id)):
                    self.pending.discard(pane_id)  # it redrew; nothing is waiting
                    self.kept.discard(pane_id)
                    continue
            except HerdrError:
                continue
            self.hit_the_wall(conn, pane_id, cfg)

    def poll_for_wall(self, conn: sqlite3.Connection, pane_ids: list[str],
                      cfg: Config) -> None:
        """Look for the limit banner ourselves, when the stream is not there.

        Events are a latency optimisation everywhere else in this file, because
        every other thing they report is re-read on the next sweep anyway. The
        wall is the exception: the subscription is the only thing watching for
        it, so a dropped stream means a pane that runs out mid-turn stays halted
        until a person notices. This is the floor under that.

        A hit here is a reason to go and ask, never a verdict. It goes through
        `hit_the_wall` exactly like a subscribed match does, so usage still
        decides and the rule holds in both paths. Reading the text and acting on
        it directly is the tempting version and the wrong one: it parks a
        perfectly healthy chat that merely mentioned running out of usage, which
        is a thing agents say to each other all day.
        """
        for pane_id in pane_ids:
            # Stalled panes are already parked, and a banner sitting on their
            # screen is the one that put them there.
            if self.stalls.get(pane_id, 0.0) > time.monotonic():
                continue
            try:
                text = self.herdr.pane_read(pane_id)
            except HerdrError as e:
                log.debug("could not read %s while polling for the wall: %s", pane_id, e)
                continue
            if LIMIT_RE.search(text):
                self.hit_the_wall(conn, pane_id, cfg)

    # --- the loop ------------------------------------------------------

    def watched(self, conn: sqlite3.Connection) -> list[str]:
        """Every pane whose wall we have to notice.

        Deliberately wider than the queue. Delivering is only ever the queue's
        business, but running out of window is not: the case this whole thing
        exists for is a chat left working overnight with nothing queued behind
        it, and watching only panes with a prompt waiting means the one session
        that actually needed picking back up is the one session nobody was
        listening to. Any pane with an agent in it can run out mid-turn, so any
        pane with an agent in it is watched.

        Queued panes stay in the set even with no agent left in them: that is
        the cold path, where the agent is gone and `pane.closed` is the thing
        that starts putting it back.
        """
        try:
            agents = list(self.herdr.agents_by_pane())
        except HerdrError as e:
            log.warning("cannot list agents, watching queued panes only: %s", e)
            agents = []
        return list(dict.fromkeys([*agents, *db.waiting_panes(conn)]))

    def tick(self, conn: sqlite3.Connection, cfg: Config) -> None:
        """One pass: forget what is done with, deliver what can go, then wait."""
        db.prune_sent(conn)
        self.sweep(conn, cfg)
        self.look_again(conn, cfg)

        panes = self.watched(conn)
        try:
            self.events.ensure(subscriptions(panes))
        except HerdrError as e:
            log.warning("cannot subscribe, falling back to polling: %s", e)

        # Only with no stream to hear it from: a live subscription already
        # reports the banner, and sampling as well would just read every pane
        # once a minute to be told what we were about to be told anyway.
        if not self.events.connected:
            self.poll_for_wall(conn, panes, cfg)

        for event in self.events.poll(cfg.poll_seconds):
            kind = event.get("event")
            data = event.get("data") or {}
            pane_id = data.get("pane_id")
            if kind == "pane.output_matched" and pane_id:
                if time.monotonic() - self.events.started_at < SUBSCRIBE_GRACE:
                    continue
                self.hit_the_wall(conn, pane_id, cfg)


class Scheduler(threading.Thread):
    """Runs the dispatch loop alongside the gateway.

    Its own thread because it spends its life blocked on Herdr's event stream,
    and its own SQLite connection because sqlite3 objects are not safe to share
    across threads -- the HTTP handlers open their own per request.
    """

    def __init__(self, config_loader):
        super().__init__(daemon=True, name="scheduler")
        self._load_config = config_loader
        self.dispatcher = Dispatcher()

    def wake(self) -> None:
        """Sweep now rather than at the next poll.

        Queueing a prompt is invisible to Herdr, so nothing in the event stream
        announces it. Without this, a message typed into an idle chat would sit
        in the queue for up to a poll interval before being delivered, which is
        the difference between a queue and a chat.
        """
        self.dispatcher.events.wake()

    def run(self) -> None:
        conn = db.connect()

        while True:
            cfg = self._load_config()  # re-read each pass so edits apply live
            try:
                self.dispatcher.tick(conn, cfg)
            except HerdrError as e:
                log.warning("herdr unavailable: %s", e)
                time.sleep(cfg.poll_seconds)
            except Exception as e:
                # Never let one bad pane kill the loop and silently stop the
                # queue -- that is the failure mode where nothing is delivered
                # and nothing says so.
                log.exception("dispatch failed: %s", e)
                time.sleep(cfg.poll_seconds)
