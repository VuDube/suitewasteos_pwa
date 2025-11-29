const CACHE_VERSION = 'v2';
const CACHE_NAME = `suitewaste-os-${CACHE_VERSION}`;

// Define the app shell files to pre-cache
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.json',
  '/vite.svg',
  // Add other critical assets like main.tsx.js, index.css, etc. after build
  // For now, we'll assume they are implicitly handled or added by a build process
  // or dynamic caching
];

// URLs that should always be fetched from the network first
const NETWORK_FIRST_URLS = [
    '/api/' // Example for API calls
];

// Install event: Pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching app shell');
      return cache.addAll(PRECACHE_URLS);
    }).then(() => {
      // Force the waiting service worker to become the active service worker
      return self.skipWaiting();
    })
  );
});

// Activate event: Clean up old caches and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clear old caches
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      console.log('[Service Worker] Old caches cleaned up');
      // Take control of all clients (tabs) immediately
      return self.clients.claim();
    })()
  );
});

// Fetch event: Hybrid caching strategy
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const requestUrl = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Check if it's a navigation request (e.g., HTML page)
  const isNavigation = request.mode === 'navigate' || (request.headers.get('accept') || '').includes('text/html');

  // --- Strategy 1: Cache-First for specific static assets (Stale-While-Revalidate) ---
  // If it's a static asset (e.g., CSS, JS, images, manifest, pre-cached items)
  // We'll treat pre-cached URLs as cache-first with revalidation.
  // This is a simplification; a full SWR would involve responding from cache
  // then updating cache in the background. For pre-cached, simple cache-first works.
  if (PRECACHE_URLS.includes(requestUrl.pathname) ||
      requestUrl.pathname.match(/\.(js|css|png|jpg|jpeg|gif|svg|webp|woff2|woff|ttf|eot)$/i)) {
    event.respondWith(caches.match(request).then(cachedResponse => {
      const fetchPromise = fetch(request).then(networkResponse => {
        // Update the cache with the latest version
        if (networkResponse.ok) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // If network fails for revalidation, but there was no cached response,
        // we might still need a fallback for *critical* pre-cached items.
        // For general static assets, failing to revalidate is often fine.
        console.log(`[Service Worker] Network failed for ${requestUrl.pathname}, serving cached if available.`);
        return caches.match(request);
      });

      return cachedResponse || fetchPromise; // Serve cached immediately, revalidate in background
    }));
    return;
  }

  // --- Strategy 2: Network-First for navigation requests with offline fallback ---
  if (isNavigation) {
    event.respondWith(
      fetch(request)
        .then(networkResponse => {
          // If network is successful, cache the response for future offline use
          if (networkResponse.ok) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          console.log('[Service Worker] Network failed for navigation, serving offline page.');
          return caches.match('/offline.html'); // Fallback to offline page
        })
    );
    return;
  }

  // --- Strategy 3: Network-First with timeout and cache fallback for API/data requests ---
  // This is a generic network-first for other requests, with a timeout.
  event.respondWith(
    (async () => {
      const API_TIMEOUT = 3000; // 3 seconds timeout for API requests

      try {
        const networkPromise = fetch(request);
        const timeoutPromise = new Promise((resolve, reject) =>
          setTimeout(() => reject(new Error('Network request timed out')), API_TIMEOUT)
        );

        // Race the network request against the timeout
        const networkResponse = await Promise.race([networkPromise, timeoutPromise]);

        // If network successful and not timed out
        if (networkResponse.ok) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      } catch (error) {
        console.log(`[Service Worker] Network or timeout failed for ${requestUrl.pathname}:`, error.message);
        // Fallback to cache
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
          return cachedResponse;
        }
        // If no cache, return a generic offline response or specific error
        return new Response('API data unavailable offline', {
          status: 503,
          statusText: 'Service Unavailable (Offline)',
          headers: { 'Content-Type': 'text/plain' }
        });
      }
    })()
  );
});

// Message listener to allow pages to trigger skipWaiting
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
