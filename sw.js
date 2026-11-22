// sw.js — the service worker.
//
// A service worker is a small script the browser runs in the background,
// between the app and the network. Ours does one job: keep a copy of the
// app's own files (HTML, CSS, JS, icons) so the app still opens with a weak
// or no connection. It never touches requests to Google or to the Apps
// Script: your data always comes fresh from the server.
//
// Strategy: "network first, cache as backup". When online you always get the
// newest files (so an update on GitHub shows up on the next open, with no
// version to bump); when offline you get the last copy that worked.

// Change this name only if you want to throw away every old cached file.
const CACHE_NAME = 'sen-tracker-v3';

// The files that make up the app. Paths are relative to sw.js, so they work
// both on localhost and under /budget-app/ on GitHub Pages.
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'statement.js',
  'config.js',
  'manifest.json',
  'privacy.html',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'fonts/Geist-latin.woff2',
  'fonts/Geist-latin-ext.woff2',
  'fonts/Geist-Medium.ttf',      // for the PDF statement
  'fonts/Geist-SemiBold.ttf',
];

/**
 * "install" runs once when a new version of this file is found. We download
 * all app files into the cache straight away, so the app works offline even
 * before the user has opened every page.
 * skipWaiting() makes the new service worker take over without waiting for
 * every open tab to close.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

/**
 * "activate" runs when this service worker takes charge. We delete caches
 * with other names (left over from older versions) and start handling
 * requests from pages that are already open (clients.claim()).
 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

/**
 * "fetch" runs for every request the app makes. We only handle GET requests
 * for our own files (same origin). Everything else, including the POSTs to
 * the Apps Script and Google's sign-in, goes to the network untouched.
 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request));
});

/**
 * Tries the network; if that works, saves a copy in the cache and returns it.
 * If the network fails (offline), returns the cached copy instead. For page
 * loads with nothing cached, falls back to the cached index.html.
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone()); // a response can only be read once
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const page = await cache.match('index.html');
      if (page) return page;
    }
    throw err;
  }
}
