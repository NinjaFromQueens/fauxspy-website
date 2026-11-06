// Faux Spy service worker. Its only job: when someone shares a photo to the
// installed app (manifest.webmanifest share_target, Android), take the image
// and hand it to /check. It caches nothing else, so pages always come fresh
// from the network. Registered with scope /share-target so it never starts
// up for ordinary page loads.

const SHARE_CACHE = 'fauxspy-share';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share-target') return;

  event.respondWith((async () => {
    try {
      const form = await event.request.formData();
      const file = form.get('image');
      if (file && file.type && file.type.startsWith('image/')) {
        const cache = await caches.open(SHARE_CACHE);
        await cache.put('/shared-image', new Response(file, {
          headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || 'shared-photo') },
        }));
        return Response.redirect('/check?shared=1', 303);
      }
    } catch (e) { /* fall through: /check explains it couldn't open the photo */ }
    return Response.redirect('/check?shared=error', 303);
  })());
});
