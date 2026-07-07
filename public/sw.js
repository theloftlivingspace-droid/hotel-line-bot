// sw.js — Billing Console service worker
// Required for iOS Web Push: the console must be added to Home Screen,
// and this SW must be registered before Notification permission / PushManager.subscribe() work.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const title = data.title || "Billing Console";
  const body = data.body || "";
  const tag = data.tag || "billing-push";
  const url = data.url || "/";

  const options = {
    body,
    tag,
    renotify: true,
    icon: "/icons/icon-billing.png",
    badge: "/icons/icon-billing.png",
    data: { url },
  };

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if (typeof data.count === "number" && self.registration.setAppBadge) {
        try {
          if (data.count > 0) await self.registration.setAppBadge(data.count);
          else await self.registration.clearAppBadge();
        } catch { /* setAppBadge unsupported, ignore */ }
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        const clientUrl = new URL(client.url);
        if (clientUrl.origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await clients.openWindow(url);
    })()
  );
});
