// Service worker de « Mes tâches » : reçoit les rappels envoyés par le service Cloudflare.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = { title: event.data && event.data.text() }; }
  const title = d.title || "Rappel";
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || "",
    tag: d.tag || undefined,
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { if (w.url.startsWith(self.registration.scope) && "focus" in w) return w.focus(); }
    return self.clients.openWindow(url);
  })());
});
