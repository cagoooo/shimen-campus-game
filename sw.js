/* 書包置物櫃: keeps the big game files (engine, game data, scripts, photos) by their content.
   GitHub Pages renews every file's ETag on each release, so without this a returning visitor re-downloads the whole
   campus after every update. Each file is stored under its SHA-256 from version.json (tools/build_web.ps1): a file
   whose content did not change is served from here, a changed one is fetched, checked against the hash and stored.
   HTML and version.json always come from the network; music and video (range requests) are left to the browser. */
const CACHE = 'shimen-campus-files-v1';
const KEEP = /\.(wasm|pck|js|webp|png)$/;
let manifest = null, manifestAt = 0;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  // Only this game's old cabinets: the origin is shared with the other cagoooo.github.io sites.
  for (const name of await caches.keys()) if (name.startsWith('shimen-campus-files-') && name !== CACHE) await caches.delete(name);
  await self.clients.claim();
})()));

const scope = () => new URL(self.registration.scope);
const keyFor = (name, sha) => { const url = new URL(name, scope()); url.search = 'sha=' + sha; return url.href; };

// Asked once per page load (a navigation clears it); a failed answer (offline) means "serve what we have".
function files() {
  const now = Date.now();
  if (!manifest || now - manifestAt > 15000) {
    manifestAt = now;
    manifest = fetch(new URL('version.json', scope()), { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null).then(info => info && info.files ? info.files : null).catch(() => null);
  }
  return manifest;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  // Each page load asks for a fresh file list, so a release is picked up on the very next visit.
  if (request.mode === 'navigate') { manifest = null; return; }
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url), base = scope();
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const name = decodeURIComponent(url.pathname.slice(base.pathname.length));
  if (!KEEP.test(name) || name === 'sw.js') return;
  event.respondWith(serve(event, url, name));
});

async function serve(event, url, name) {
  const list = await files();
  const want = list && list[name];
  const cache = await caches.open(CACHE).catch(() => null);
  if (want && cache) {
    const hit = await cache.match(keyFor(name, want.sha256));
    if (hit) return hit;
  }
  let response;
  try {
    response = await fetch(url.href, { cache: 'no-cache' });
  } catch (error) {
    // Offline: any copy of this file we still hold.
    const old = cache && await oldCopy(cache, name);
    if (old) return old;
    throw error;
  }
  if (!want || !cache || response.status !== 200 || !response.body) return response;
  // One stream to the game (the loading bar keeps moving), one to the cabinet once its hash matches.
  const [toPage, toCache] = response.body.tee();
  const type = response.headers.get('content-type') || 'application/octet-stream';
  event.waitUntil(store(cache, name, want.sha256, toCache, type).catch(() => {}));
  const headers = new Headers(response.headers);
  headers.delete('content-encoding'); headers.delete('content-length'); // the stream is already unpacked
  return new Response(toPage, { status: 200, statusText: response.statusText, headers });
}

async function store(cache, name, sha, stream, type) {
  const blob = await new Response(stream).blob();
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  // Right after a release the server can still hand out the previous file for a moment: never store it under the new hash.
  if (hex !== sha) return;
  await cache.put(keyFor(name, sha), new Response(blob, { headers: { 'content-type': type, 'content-length': String(blob.size) } }));
  const path = new URL(name, scope()).pathname;
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.pathname === path && url.search !== '?sha=' + sha) await cache.delete(request);
  }
}

async function oldCopy(cache, name) {
  const path = new URL(name, scope()).pathname;
  for (const request of await cache.keys()) if (new URL(request.url).pathname === path) return cache.match(request);
  return null;
}
