self.addEventListener("push", (event) => {
  let message;
  try {
    message = event.data?.json();
  } catch {
    return;
  }
  if (!message || typeof message.url !== "string") return;

  let target;
  try {
    target = new URL(message.url, self.location.origin);
  } catch {
    return;
  }
  if (target.origin !== self.location.origin) return;

  event.waitUntil(
    self.registration.showNotification("Codex needs your input", {
      body: "Open Codex to respond.",
      tag: "codex-user-input",
      data: { url: target.href },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url;
  if (typeof targetUrl !== "string") return;

  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return;
  }
  if (target.origin !== self.location.origin) return;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if ("focus" in client && "navigate" in client) {
            await client.navigate(target.href);
            await client.focus();
            return;
          }
        }
        await self.clients.openWindow(target.href);
      }),
  );
});
