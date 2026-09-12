/* Service worker for Sheep It.
 *
 * Pushes carry no payload (encrypting one needs crypto the stdlib-only
 * gateway cannot do), so on wake we fetch the agent list ourselves and
 * describe whatever is no longer working. */

const IDLE = ["idle", "done", "blocked"];

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

function whoFinished(last) {
  if (!last || !last.agents || !last.agents.length) return "";
  if (last.age !== null && last.age > FRESH_SECONDS) return ""; // a stale record
  const names = last.agents.map((a) => a.name).filter(Boolean);
  if (!names.length) return "";
  if (names.length === 1) return `${names[0]} finished`;
  if (names.length === 2) return `${names[0]} and ${names[1]} finished`;
  return `${names[0]} and ${names.length - 1} others finished`;
}

function waitingLine(count) {
  if (count <= 0) return "Tap to open.";
  return count === 1 ? "1 agent waiting for you" : `${count} agents waiting for you`;
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "Agent finished";
      let body = "An agent is waiting for you.";

      try {
        const [agentsRes, lastRes] = await Promise.all([
          fetch("/api/agents", { cache: "no-store" }).catch(() => null),
          fetch("/api/push/last", { cache: "no-store" }).catch(() => null),
        ]);
        const data = await readJson(agentsRes);
        const last = await readJson(lastRes);

        const done = ((data && data.agents) || []).filter(
          (a) => a.has_agent && IDLE.includes(a.status)
        );
        /* Only when the list was actually read. Off the tailnet the fetch
           fails, and clearing the badge on that would wipe the one part of a
           frozen home screen icon that still says anything. */
        if (data) await setBadge(done.length);

        const finished = whoFinished(last);
        if (finished) {
          title = finished;
          body = waitingLine(done.length);
        } else if (done.length === 1) {
          // No usable record: fall back to describing the list.
          title = done[0].name || "Agent finished";
          body = done[0].title || `${done[0].status} — tap to open`;
        } else if (done.length > 1) {
          title = `${done.length} agents waiting`;
          body = done.map((a) => a.name).join(", ");
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
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("/");
    })()
  );
});
