/* Gauntlet Coach — service worker.
 *
 * Chrome on Android only offers "Install app" (full screen, no browser bar)
 * when the site has a service worker that handles page loads. This one does
 * the minimum: page loads go to the network as normal, and if there's no
 * connection it shows a clear "you're offline" screen instead of Chrome's
 * dinosaur. It caches nothing, so coaches always get the live app, and every
 * deploy shows up right away.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const OFFLINE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#08182E"><title>Gauntlet Coach</title>
<style>
  html,body{margin:0;height:100%;background:#08182E;color:#fff;font-family:system-ui,sans-serif}
  body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px}
  h1{font:700 26px/1.1 Impact,'Barlow Condensed',sans-serif;text-transform:uppercase;letter-spacing:.03em;margin:0 0 8px}
  p{color:#A9BFD8;margin:0 0 22px;font-size:15px}
  button{border:0;border-radius:10px;background:#3D8BFF;color:#fff;padding:13px 26px;font:600 15px system-ui,sans-serif}
</style></head><body>
  <h1>No connection</h1>
  <p>Gauntlet Coach needs the internet to load today's programming.</p>
  <button onclick="location.reload()">Try again</button>
</body></html>`;

self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return;          // videos, data, images: untouched
  e.respondWith(fetch(e.request).catch(() =>
    new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
