self.addEventListener('push', event => {
  let data = {};
  try { data = event.data?.json() || {}; } catch (_) { data = {}; }
  event.waitUntil(self.registration.showNotification(data.title || 'いま営業中のお店', {
    body: data.body || '店舗の災害情報が更新されました。',
    icon: './app-icon.svg', badge: './app-icon.svg',
    tag: data.tag || 'restaurant-disaster',
    data: { url: new URL('./', self.registration.scope).href },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || new URL('./', self.registration.scope).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async windows => {
    const existing = windows.find(w => w.url.startsWith(new URL('./', self.registration.scope).href));
    if (existing) return existing.focus();
    return clients.openWindow(url);
  }));
});
