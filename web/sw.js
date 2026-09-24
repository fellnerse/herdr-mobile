/* Service worker for Sheep It.
 *
 * Pushes carry no payload (encrypting one needs crypto the stdlib-only
 * gateway cannot do), so on wake we fetch the agent list ourselves, together
 * with the transition the gateway parked, and describe that. */

/* What counts as waiting on you: a turn that ended and nobody has looked at
   it yet, and an agent stopped on a question. A pane merely sitting at its
   prompt is not waiting for anything - counting those is what made one agent
   finishing read as the whole herd calling for you. */
const WAITING = ["done", "blocked"];

/* The home screen icon itself is frozen at install time - iOS snapshots it and
   never asks again - so the badge is the only part of it that can still say
   something. It carries the number of agents waiting on you. Badges need the
   same notification permission as this push, so by the time we are here it is
   granted. */
async function setBadge(count) {
  try {
    if (!("setAppBadge" in self.navigator)) return;
    if (count > 0) await self.navigator.setAppBadge(count);
    else await self.navigator.clearAppBadge();
  } catch (err) {
    /* badge unsupported or permission revoked mid-flight */
  }
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

/* "two agents waiting" is the state of the herd; it is not what just happened.
   The push itself carries no payload, so the gateway parks the transition it
   saw and we come and read it - otherwise a notification can only describe the
   list, never the event that caused it. */
const FRESH_SECONDS = 120;

/* An older gateway has no /api/push/last, and unknown paths there fall through
   to index.html - a 200 full of HTML. Parsing that throws, and a throw here
   would cost the whole notification its text, so every response is checked
   before it is believed. */
async function readJson(res) {
  if (!res || !res.ok) return null;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return null;
  try {
    return await res.json();
  } catch (err) {
    return null;
  }
}

/* A workspace running two agents at once would otherwise be named twice over -
   "sheepit, sheepit" - so the gateway hands out a name that says which tab.
   An older gateway has no such field and the project's name is all there is. */
function agentName(row) {
  return row.display_name || row.name || "";
}

function names(agents) {
  const list = agents.map(agentName).filter(Boolean);
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list[0]} and ${list.length - 1} others`;
}

/* Describe the event the gateway parked, and only that event. Saying "3 agents
   waiting" in the title made every agent that had ever stopped look like it
   had just stopped again - so the herd's total, if it is said at all, is said
   last and as background. */
function describe(last) {
  if (!last || !last.agents || !last.agents.length) return null;
  if (last.age !== null && last.age > FRESH_SECONDS) return null; // a stale record
  if (last.title && last.body) return { title: last.title, body: last.body };
  const who = names(last.agents);
  if (!who) return null;
  const asking = last.agents.filter((a) => a.status === "blocked");
  if (asking.length === last.agents.length) {
    return { title: `${who} needs you`, body: last.agents[0].title || "A question is waiting." };
  }
  if (asking.length) {
    return { title: `${who} stopped`, body: `${names(asking)} is asking something.` };
  }
  return { title: `${who} finished`, body: last.agents[0].title || "Tap to open." };
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "Agent finished";
      let body = "An agent is waiting for you.";
      let url = "/";

      try {
        const [agentsRes, lastRes] = await Promise.all([
          fetch("/api/agents", { cache: "no-store" }).catch(() => null),
          fetch("/api/push/last", { cache: "no-store" }).catch(() => null),
        ]);
        const data = await readJson(agentsRes);
        const last = await readJson(lastRes);

        const waiting = ((data && data.agents) || []).filter(
          (a) => a.has_agent && WAITING.includes(a.status)
        );
        /* Only when the list was actually read. Off the tailnet the fetch
           fails, and clearing the badge on that would wipe the one part of a
           frozen home screen icon that still says anything. */
        if (data) await setBadge(waiting.length);

        const said = describe(last);
        // A chat names the page it lives on; a pane is found from the flock.
        if (said && last.url) url = last.url;
        if (said) {
          title = said.title;
          body = said.body;
          // The rest of the herd is context, never the headline.
          if (waiting.length > last.agents.length) {
            body += ` · ${waiting.length - last.agents.length} more waiting`;
          }
        } else if (waiting.length === 1) {
          // No usable record: say the least that is still true.
          title = agentName(waiting[0]) || "Agent finished";
          body = waiting[0].title || "Tap to open.";
        }
      } catch (err) {
        /* offline or gateway down: the generic text above still fires */
      }

      await self.registration.showNotification(title, {
        body,
        tag: "sheepit-agent",       // collapse repeats into one notification
        renotify: true,
        icon: "/icon.svg",
        badge: "/icon.svg",
        data: { url },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const url = (event.notification.data && event.notification.data.url) || "/";
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if (url !== "/" && "navigate" in client) {
          await client.navigate(url).catch(() => null);
        }
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })()
  );
});
