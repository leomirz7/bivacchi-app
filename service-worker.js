// Service Worker per Bivacchi PWA
const CACHE_VERSION = 'bivacchi-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const MAP_CACHE = `${CACHE_VERSION}-maps`;

// Risorse statiche da cachare immediatamente
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/style.css',
    '/script.js',
    '/manifest.json',
    '/icons/icon.svg',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://cdn.jsdelivr.net/npm/nouislider@15.8.0/dist/nouislider.min.css',
    'https://cdn.jsdelivr.net/npm/nouislider@15.8.0/dist/nouislider.min.js'
];

// Patterns per le API da cachare
const API_PATTERNS = [
    /\/api\/bivacchi$/,
    /\/api\/me$/
];

// Pattern per tile mappa (cache con limite)
const MAP_TILE_PATTERN = /tile\.openstreetmap\.org/;

// Limite tile mappa in cache (per non riempire storage)
const MAX_MAP_TILES = 500;

// Install: pre-cache risorse statiche
self.addEventListener('install', (event) => {
    console.log('[SW] Installing...');
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then(cache => {
                console.log('[SW] Pre-caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => self.skipWaiting())
            .catch(err => console.error('[SW] Pre-cache failed:', err))
    );
});

// Activate: pulisci vecchie cache
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating...');
    event.waitUntil(
        caches.keys()
            .then(keys => {
                return Promise.all(
                    keys.filter(key => key.startsWith('bivacchi-') && key !== STATIC_CACHE && key !== DATA_CACHE && key !== MAP_CACHE)
                        .map(key => {
                            console.log('[SW] Deleting old cache:', key);
                            return caches.delete(key);
                        })
                );
            })
            .then(() => self.clients.claim())
    );
});

// Fetch: strategia intelligente basata sul tipo di risorsa
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Skip non-GET requests
    if (event.request.method !== 'GET') return;
    
    // Skip chrome-extension e altri schemi
    if (!url.protocol.startsWith('http')) return;

    // Strategia per API dati bivacchi: Network first, fallback cache
    if (API_PATTERNS.some(pattern => pattern.test(url.pathname))) {
        event.respondWith(networkFirstWithCache(event.request, DATA_CACHE));
        return;
    }

    // Strategia per API meteo esterne: Network only con timeout, no cache (dati volatili)
    if (url.hostname.includes('open-meteo.com') || url.hostname.includes('overpass-api.de')) {
        event.respondWith(networkOnlyWithTimeout(event.request, 10000));
        return;
    }

    // Strategia per tile mappa: Cache first, network fallback (con limite cache)
    if (MAP_TILE_PATTERN.test(url.hostname)) {
        event.respondWith(cacheFirstWithNetworkFallback(event.request, MAP_CACHE, true));
        return;
    }

    // Strategia per risorse statiche: Cache first, network fallback
    if (STATIC_ASSETS.includes(url.pathname) || STATIC_ASSETS.includes(url.href)) {
        event.respondWith(cacheFirstWithNetworkFallback(event.request, STATIC_CACHE));
        return;
    }

    // Default: Stale-while-revalidate per altre risorse
    event.respondWith(staleWhileRevalidate(event.request, STATIC_CACHE));
});

// Network first con fallback cache (per API)
async function networkFirstWithCache(request, cacheName) {
    try {
        const networkResponse = await fetchWithTimeout(request, 8000);
        if (networkResponse.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (err) {
        console.log('[SW] Network failed, trying cache:', request.url);
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        // Ritorna risposta offline per API bivacchi
        if (request.url.includes('/api/bivacchi')) {
            return new Response(JSON.stringify([]), {
                headers: { 'Content-Type': 'application/json' },
                status: 503,
                statusText: 'Offline - cached data may be available in app'
            });
        }
        throw err;
    }
}

// Cache first con network fallback
async function cacheFirstWithNetworkFallback(request, cacheName, isMapTile = false) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
        // Aggiorna cache in background per risorse non-mappa
        if (!isMapTile) {
            fetchAndCache(request, cacheName);
        }
        return cachedResponse;
    }

    try {
        const networkResponse = await fetchWithTimeout(request, 5000);
        if (networkResponse.ok) {
            const cache = await caches.open(cacheName);
            
            // Per tile mappa, limita la cache
            if (isMapTile) {
                await limitMapCache(cache);
            }
            
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (err) {
        console.log('[SW] Fetch failed for:', request.url);
        // Per tile mappa, ritorna placeholder trasparente
        if (isMapTile) {
            return new Response('', { status: 404 });
        }
        throw err;
    }
}

// Stale-while-revalidate
async function staleWhileRevalidate(request, cacheName) {
    const cachedResponse = await caches.match(request);
    
    const fetchPromise = fetchWithTimeout(request, 5000)
        .then(networkResponse => {
            if (networkResponse.ok) {
                caches.open(cacheName).then(cache => cache.put(request, networkResponse.clone()));
            }
            return networkResponse;
        })
        .catch(() => cachedResponse);

    return cachedResponse || fetchPromise;
}

// Network only con timeout (per API meteo)
async function networkOnlyWithTimeout(request, timeout) {
    try {
        return await fetchWithTimeout(request, timeout);
    } catch (err) {
        return new Response(JSON.stringify({ error: 'offline' }), {
            headers: { 'Content-Type': 'application/json' },
            status: 503
        });
    }
}

// Fetch con timeout
function fetchWithTimeout(request, timeout) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
        fetch(request)
            .then(response => {
                clearTimeout(timer);
                resolve(response);
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

// Fetch e cache in background
async function fetchAndCache(request, cacheName) {
    try {
        const response = await fetch(request);
        if (response.ok) {
            const cache = await caches.open(cacheName);
            cache.put(request, response);
        }
    } catch (err) {
        // Ignora errori di background fetch
    }
}

// Limita cache tile mappa
async function limitMapCache(cache) {
    const keys = await cache.keys();
    if (keys.length > MAX_MAP_TILES) {
        // Rimuovi i tile più vecchi (primi 100)
        const toDelete = keys.slice(0, 100);
        await Promise.all(toDelete.map(key => cache.delete(key)));
        console.log('[SW] Cleaned old map tiles:', toDelete.length);
    }
}

// Gestione messaggi dal client
self.addEventListener('message', (event) => {
    if (event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    
    if (event.data.type === 'CACHE_BIVACCHI') {
        // Cache manuale dei dati bivacchi
        caches.open(DATA_CACHE).then(cache => {
            cache.put('/api/bivacchi', new Response(JSON.stringify(event.data.data), {
                headers: { 'Content-Type': 'application/json' }
            }));
        });
    }
    
    if (event.data.type === 'GET_CACHE_STATUS') {
        getCacheStatus().then(status => {
            event.ports[0].postMessage(status);
        });
    }
});

// Ottieni stato cache
async function getCacheStatus() {
    const cacheNames = await caches.keys();
    const status = {};
    
    for (const name of cacheNames) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        status[name] = keys.length;
    }
    
    return status;
}

// Sync in background quando torna online
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-data') {
        event.waitUntil(syncData());
    }
});

async function syncData() {
    // Notifica i client che siamo online
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
        client.postMessage({ type: 'ONLINE_SYNC' });
    });
}
