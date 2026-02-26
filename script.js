function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// ==================== PWA ONLINE/OFFLINE SYNC MANAGER ====================
const SyncManager = {
    QUEUE_KEY: 'bivacchi_sync_queue',
    getQueue() { try { return JSON.parse(localStorage.getItem(this.QUEUE_KEY) || '[]'); } catch { return []; } },
    addToQueue(action) {
        const queue = this.getQueue();
        action.timestamp = Date.now();
        action.id = Math.random().toString(36).substr(2, 9);
        queue.push(action);
        localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
        showConnectionBanner('offline-pending');
    },
    removeFromQueue(id) {
        let queue = this.getQueue();
        queue = queue.filter(item => item.id !== id);
        localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
    },
    async processQueue() {
        const queue = this.getQueue();
        if (queue.length === 0) return;
        showConnectionBanner('syncing');
        for (const action of queue) {
            try {
                let success = false;
                switch (action.type) {
                    case 'COMMENT': success = await this.syncComment(action); break;
                    case 'FAVORITE': success = await this.syncFavorite(action); break;
                    case 'ADDRESS': success = await this.syncAddress(action); break;
                }
                if (success) this.removeFromQueue(action.id);
            } catch (e) { console.error(`[SyncManager] Failed:`, e); }
        }
        if (this.getQueue().length === 0) {
            showConnectionBanner('online');
            if (currentUser) checkAuth();
        }
    },
    async syncComment(a) { const r = await fetch(`${API_BASE_URL}/api/bivacchi/${a.bivaccoId}/comments`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:a.text}) }); return r.ok; },
    async syncFavorite(a) { const r = await fetch(`/api/favorites/${a.bivaccoId}`, { method:'POST' }); return r.ok; },
    async syncAddress(a) { const r = await fetch(API_BASE_URL+'/api/home-address', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(a.payload) }); return r.ok; }
};

// ==================== GLOBAL API QUEUE ====================
const API_QUEUE_DELAY = 350;
let apiQueueLastTime = 0;
let apiQueuePending = [];
let apiQueueProcessing = false;

async function enqueueApiCall(fn) {
    return new Promise((resolve, reject) => {
        apiQueuePending.push({ fn, resolve, reject });
        processApiQueue();
    });
}

async function processApiQueue() {
    if (apiQueueProcessing || apiQueuePending.length === 0) return;
    apiQueueProcessing = true;
    while (apiQueuePending.length > 0) {
        const { fn, resolve, reject } = apiQueuePending.shift();
        const elapsed = Date.now() - apiQueueLastTime;
        if (elapsed < API_QUEUE_DELAY) await new Promise(r => setTimeout(r, API_QUEUE_DELAY - elapsed));
        apiQueueLastTime = Date.now();
        try { resolve(await fn()); } catch (error) { reject(error); }
    }
    apiQueueProcessing = false;
}

// ==================== DATA VALIDATION ====================
const DataStatus = { LOADING:'loading', AVAILABLE:'available', UNAVAILABLE:'unavailable', STALE:'stale', CORRUPTED:'corrupted' };

function validateElevation(el) {
    const ele = el.tags?.ele;
    if (ele === undefined || ele === null || ele === '') return DataStatus.UNAVAILABLE;
    const num = parseInt(ele, 10);
    if (isNaN(num)) return DataStatus.CORRUPTED;
    if (num < 0 || num > 5000) return DataStatus.CORRUPTED;
    if (num === 0) return DataStatus.UNAVAILABLE;
    return DataStatus.AVAILABLE;
}

function validateTemperature(el) {
    const temp = el.tags?.temperature;
    const updatedAt = el.tags?.temperature_updated_at;
    if (temp === undefined || temp === null) return DataStatus.UNAVAILABLE;
    const num = parseInt(temp, 10);
    if (isNaN(num)) return DataStatus.CORRUPTED;
    if (num < -50 || num > 50) return DataStatus.CORRUPTED;
    if (updatedAt && Date.now() - updatedAt > 2 * 60 * 60 * 1000) return DataStatus.STALE;
    return DataStatus.AVAILABLE;
}

function validateBivacco(el) {
    return { elevation: validateElevation(el), temperature: validateTemperature(el), hasAspect: !!(el.tags?.aspect_card), hasSnow: el.tags?.snow !== undefined, hasDaylight: !!(el.tags?.sunrise && el.tags?.sunset) };
}

function findBivacchiToRepair(data) {
    const toRepair = { elevation: [], temperature: [], aspect: [], snow: [], daylight: [] };
    for (const el of data) {
        const s = validateBivacco(el);
        if (s.elevation !== DataStatus.AVAILABLE) toRepair.elevation.push(el);
        if (s.temperature !== DataStatus.AVAILABLE) toRepair.temperature.push(el);
        if (!s.hasAspect) toRepair.aspect.push(el);
        if (!s.hasSnow) toRepair.snow.push(el);
        if (!s.hasDaylight) toRepair.daylight.push(el);
    }
    return toRepair;
}

// ==================== PROGRESS ====================
function showProgress(label, percent) {
    const c = document.getElementById('progress-bar-container');
    const b = document.getElementById('progress-bar');
    const l = document.getElementById('progress-label');
    if (c && b && l) { c.classList.add('active'); l.classList.add('active'); b.style.width = `${percent}%`; l.textContent = label; }
}
function hideProgress() {
    const c = document.getElementById('progress-bar-container');
    const l = document.getElementById('progress-label');
    if (c && l) { c.classList.remove('active'); l.classList.remove('active'); }
}

// ==================== BACKGROUND DATA MANAGER ====================
const BackgroundDataManager = {
    isRunning: false, currentJob: null, abortController: null,
    totalItems: 0, processedItems: 0,
    BATCH_SIZE: 50, MAX_ERRORS: 3,
    WEATHER_STALE_MS: 60 * 60 * 1000,
    DAYLIGHT_STALE_MS: 24 * 60 * 60 * 1000,

    updateProgress(current, total, jobName) { showProgress(`${jobName}: ${current}/${total}`, Math.round((current/total)*100)); },

    async startAllJobs(data) {
        if (this.isRunning || !navigator.onLine) return;
        this.isRunning = true;
        this.abortController = new AbortController();
        try {
            await this.fetchMissingElevations(data);
            await this.computeStaticData(data);
            await this.updateWeatherData(data);
            await this.updateDaylightData(data);
        } catch (e) { if (e.name !== 'AbortError') console.error('[BDM]', e); }
        finally { this.isRunning = false; this.currentJob = null; hideProgress(); pendingUIUpdate = true; throttledUIUpdate(); }
    },
    stop() { if (this.abortController) this.abortController.abort(); this.isRunning = false; },

    async fetchMissingElevations(data) {
        this.currentJob = 'elevations';
        const toFetch = data.filter(el => !el.tags?.ele || el.tags.ele === '0' || el.tags.ele === 0);
        if (toFetch.length === 0) return;
        let successCount = 0, errorCount = 0, processed = 0;
        for (const el of toFetch) {
            if (this.abortController.signal.aborted) throw new DOMException('Aborted','AbortError');
            processed++;
            this.updateProgress(processed, toFetch.length, 'Altitudini');
            const lat = el.center?.lat ?? el.lat, lon = el.center?.lon ?? el.lon;
            if (!lat || !lon) continue;
            try {
                const elevation = await enqueueApiCall(async () => {
                    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
                    if (!r.ok) return null;
                    const d = await r.json();
                    return (d.elevation?.length > 0 && !isNaN(d.elevation[0])) ? Math.round(Number(d.elevation[0])) : null;
                });
                if (elevation !== null) { el.tags = el.tags || {}; el.tags.ele = elevation; successCount++; errorCount = 0;
                    if (successCount % this.BATCH_SIZE === 0) { await saveBivacchiToStorage(rawData); pendingUIUpdate = true; throttledUIUpdate(); }
                } else errorCount++;
            } catch { errorCount++; }
            if (errorCount >= this.MAX_ERRORS) break;
        }
        if (successCount > 0) { await this.saveProgress(data, true); pendingUIUpdate = true; throttledUIUpdate(); }
    },

    async computeStaticData(data) { this.currentJob = 'static'; /* Disabled - use server admin endpoint */ },

    async updateWeatherData(data) {
        this.currentJob = 'weather';
        const now = Date.now();
        const toUpdate = data.filter(el => (now - (el.tags?.temperature_updated_at || 0)) > this.WEATHER_STALE_MS);
        if (toUpdate.length === 0) return;
        let successCount = 0, errorCount = 0, processed = 0;
        for (const el of toUpdate) {
            if (this.abortController.signal.aborted) throw new DOMException('Aborted','AbortError');
            processed++;
            this.updateProgress(processed, toUpdate.length, 'Temperature');
            try {
                if (await fetchTemperature(el)) { successCount++; errorCount = 0;
                    if (successCount % this.BATCH_SIZE === 0) { await saveBivacchiToStorage(rawData); pendingUIUpdate = true; throttledUIUpdate(); }
                } else errorCount++;
            } catch { errorCount++; }
            if (errorCount >= this.MAX_ERRORS) break;
        }
        if (successCount > 0) { await saveBivacchiToStorage(rawData); pendingUIUpdate = true; throttledUIUpdate(); }
    },

    async updateDaylightData(data) {
        this.currentJob = 'daylight';
        const now = Date.now();
        const toUpdate = data.filter(el => (now - (el.tags?.daylight_updated_at || 0)) > this.DAYLIGHT_STALE_MS);
        if (toUpdate.length === 0) return;
        let successCount = 0, errorCount = 0;
        for (const el of toUpdate) {
            if (this.abortController.signal.aborted) throw new DOMException('Aborted','AbortError');
            try { await fetchDaylightForEl(el); successCount++; errorCount = 0;
                if (successCount % this.BATCH_SIZE === 0) await saveBivacchiToStorage(rawData);
            } catch { errorCount++; }
            if (errorCount >= this.MAX_ERRORS) break;
        }
        if (successCount > 0) await saveBivacchiToStorage(rawData);
    },

    async saveProgress(data, syncToServer = false) {
        await saveBivacchiToStorage(data);
        if (syncToServer && navigator.onLine) {
            try { await fetch(API_BASE_URL + '/api/bivacchi', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(data) }); } catch {}
        }
    }
};

// ==================== PWA ====================
let isOnline = navigator.onLine;
let swRegistration = null;
let deferredInstallPrompt = null;

async function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        try {
            swRegistration = await navigator.serviceWorker.register('/service-worker.js');
            console.log('[PWA] Service Worker registered, scope:', swRegistration.scope);
            swRegistration.addEventListener('updatefound', () => {
                const nw = swRegistration.installing;
                nw.addEventListener('statechange', () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner();
                });
            });
            navigator.serviceWorker.addEventListener('message', (e) => {
                if (e.data.type === 'ONLINE_SYNC') handleOnlineSync();
            });
        } catch (err) { console.error('[PWA] SW registration failed:', err); }
    }
}

// ── PWA Install Prompt ──
function setupInstallPrompt() {
    const banner = document.getElementById('pwa-install-banner');
    const acceptBtn = document.getElementById('pwa-install-accept');
    const dismissBtn = document.getElementById('pwa-install-dismiss');
    if (!banner) return;

    // Listen for the browser's install prompt
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredInstallPrompt = e;
        console.log('[PWA] Install prompt captured');
        // Don't show if user already dismissed recently
        const dismissed = localStorage.getItem('pwa-install-dismissed');
        if (dismissed && Date.now() - parseInt(dismissed) < 7 * 24 * 60 * 60 * 1000) return;
        // Show the banner after a short delay
        setTimeout(() => { banner.style.display = 'flex'; }, 3000);
    });

    acceptBtn?.addEventListener('click', async () => {
        if (!deferredInstallPrompt) return;
        banner.style.display = 'none';
        deferredInstallPrompt.prompt();
        const result = await deferredInstallPrompt.userChoice;
        console.log('[PWA] Install choice:', result.outcome);
        deferredInstallPrompt = null;
    });

    dismissBtn?.addEventListener('click', () => {
        banner.style.display = 'none';
        localStorage.setItem('pwa-install-dismissed', Date.now().toString());
        deferredInstallPrompt = null;
    });

    window.addEventListener('appinstalled', () => {
        console.log('[PWA] App installed!');
        banner.style.display = 'none';
        deferredInstallPrompt = null;
    });

    // iOS standalone detection — show a custom hint for iOS users
    if (isIOSNonStandalone()) {
        const dismissed = localStorage.getItem('pwa-ios-hint-dismissed');
        if (!dismissed || Date.now() - parseInt(dismissed) > 30 * 24 * 60 * 60 * 1000) {
            setTimeout(() => showIOSInstallHint(), 5000);
        }
    }
}

function isIOSNonStandalone() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    return isIOS && !isStandalone;
}

function showIOSInstallHint() {
    const hint = document.createElement('div');
    hint.className = 'pwa-ios-hint';
    hint.innerHTML = `
        <div class="pwa-ios-hint-content">
            <span>Per installare l'app: tocca</span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
            </svg>
            <span>poi <strong>"Aggiungi a Home"</strong></span>
        </div>
        <button class="pwa-ios-hint-close" onclick="this.parentElement.remove();localStorage.setItem('pwa-ios-hint-dismissed',Date.now().toString())">✕</button>
    `;
    document.body.appendChild(hint);
    // Auto-dismiss after 12 seconds
    setTimeout(() => { if (hint.parentElement) { hint.classList.add('fade-out'); setTimeout(() => hint.remove(), 500); } }, 12000);
}

function setupOnlineOfflineHandlers() {
    window.addEventListener('online', () => { isOnline = true; showConnectionBanner('online'); handleOnlineSync(); });
    window.addEventListener('offline', () => { isOnline = false; showConnectionBanner('offline'); });
}

async function handleOnlineSync() {
    SyncManager.processQueue();
    if (typeof DBService !== 'undefined') { try { await DBService.processSyncQueue(API_BASE_URL); } catch {} }
    if (rawData.length > 0) BackgroundDataManager.startAllJobs(rawData);
}

function showConnectionBanner(status) {
    document.querySelector('.connection-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = `connection-banner ${status}`;
    if (status === 'online') { banner.innerHTML = '✅ Connessione ripristinata'; banner.style.background = 'linear-gradient(135deg,#27ae60,#2ecc71)'; }
    else if (status === 'syncing') { banner.innerHTML = '🔄 Sincronizzazione...'; banner.style.background = 'linear-gradient(135deg,#f39c12,#f1c40f)'; }
    else if (status === 'offline-pending') { banner.innerHTML = '💾 Salvato localmente'; banner.style.background = 'linear-gradient(135deg,#e67e22,#d35400)'; }
    else { banner.innerHTML = '📴 Offline - le modifiche verranno salvate'; banner.style.background = 'linear-gradient(135deg,#e74c3c,#c0392b)'; }
    document.body.prepend(banner);
    if (status === 'online' || status === 'offline-pending') {
        setTimeout(() => { banner.classList.add('fade-out'); setTimeout(() => banner.remove(), 500); }, status === 'online' ? 4000 : 3000);
    }
}

function showUpdateBanner() {
    const banner = document.createElement('div');
    banner.className = 'connection-banner';
    banner.style.background = 'linear-gradient(135deg,#8b5cf6,#7c3aed)';
    banner.innerHTML = 'Aggiornamento disponibile <button onclick="location.reload()" style="margin-left:10px;padding:4px 12px;border:none;border-radius:6px;background:white;color:#7c3aed;cursor:pointer;font-weight:500">Aggiorna</button>';
    document.body.prepend(banner);
}

function cacheBivacchiInSW(data) {
    if (navigator.serviceWorker?.controller) navigator.serviceWorker.controller.postMessage({ type: 'CACHE_BIVACCHI', data });
}

registerServiceWorker();
setupInstallPrompt();
setupOnlineOfflineHandlers();

// ==================== CONSTANTS ====================
const API_BASE_URL = '';
const SNOW_DEPTH_THRESHOLD_CM = 1;
const SNOWFALL_RECENT_THRESHOLD_MM = 5;
const SNOW_RECENT_HOURS = 48;
const TEMP_FREEZE_THRESHOLD_C = 0;
const TEMP_NEAR_FREEZE_C = 2;
const ALTITUDE_SNOW_SUPPORT_M = 1700;
const WEATHER_STALE_MS = 60 * 60 * 1000;
const DAYLIGHT_STALE_MS = 24 * 60 * 60 * 1000;
const SLOPE_SAMPLE_OFFSET_DEG = 0.001;
const ELEVATION_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
let elevationCache = {};

// ==================== SOLAR POSITION & DAYLIGHT ====================
function solarPosition(lat, lon, date = new Date()) {
    const deg2rad = Math.PI / 180;
    const J2000 = 2451545.0;
    const JD = date.getTime() / 86400000 + 2440587.5;
    const T = (JD - J2000) / 36525;
    const L0 = (280.46646 + 36000.76983 * T) % 360;
    const M = (357.52911 + 35999.05029 * T) % 360;
    const C = (1.914602 - 0.004817 * T) * Math.sin(M * deg2rad) + 0.019993 * Math.sin(2 * M * deg2rad);
    const lambda = (L0 + C) % 360;
    const epsilon = 23.4393 - 0.0130 * T;
    const delta = Math.asin(Math.sin(epsilon * deg2rad) * Math.sin(lambda * deg2rad)) / deg2rad;
    const H0 = Math.acos(-Math.tan(lat * deg2rad) * Math.tan(delta * deg2rad)) / deg2rad;
    return { declination: delta, H0 };
}

function calculateDaylight(lat, lon, elev_m = 0, slope_deg = 0, aspect_deg = 0, date = new Date()) {
    try {
        const sp = solarPosition(lat, lon, date);
        let H0 = sp.H0;
        const horizonDip = Math.sqrt((2 * Math.max(0, elev_m)) / 6371000) * (180 / Math.PI);
        H0 -= horizonDip;
        if (slope_deg > 10 && Math.abs((aspect_deg + 180) % 360 - 180) < 90) H0 -= slope_deg * 0.1;
        H0 = Math.min(90, Math.max(0, H0));
        const daylight_hours = Math.max(0, (2 * H0) / 15);
        const lonOffset = 4 * (lon - 15) / 60;
        const solarNoonUTC = 12 + lonOffset;
        const tzOffset = -date.getTimezoneOffset() / 60;
        const formatTime = (hours) => {
            let totalMinutes = Math.round(hours * 60) % (24 * 60);
            if (totalMinutes < 0) totalMinutes += 24 * 60;
            return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
        };
        return { sunrise: formatTime(solarNoonUTC - H0 / 15 + tzOffset), sunset: formatTime(solarNoonUTC + H0 / 15 + tzOffset), daylight_hours: Math.round(daylight_hours * 100) / 100 };
    } catch { return null; }
}

function escapeHtml(str) { return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function isDaylightInvalid(tags = {}) {
    const { sunrise, sunset, daylight_hours } = tags;
    if (!sunrise || !sunset || daylight_hours == null) return true;
    if (!/^\d{2}:\d{2}$/.test(sunrise) || !/^\d{2}:\d{2}$/.test(sunset)) return true;
    const dh = Number(daylight_hours);
    if (!Number.isFinite(dh) || dh <= 0 || dh > 24 || sunrise === sunset) return true;
    return false;
}

async function fetchDaylightForEl(el) {
    const lat = el.center?.lat ?? el.lat, lon = el.center?.lon ?? el.lon;
    const daylight = calculateDaylight(lat, lon, parseInt(el.tags?.ele ?? 0) || 0, el.tags?.slope_deg ?? 0, el.tags?.aspect_deg ?? 0);
    if (daylight) { el.tags = el.tags || {}; Object.assign(el.tags, daylight, { daylight_updated_at: Date.now() }); return true; }
    return false;
}

function metersPerDegree(lat) { const r = (lat * Math.PI) / 180; return { mPerDegLat: 111320, mPerDegLon: 111320 * Math.cos(r) }; }
function degToCardinal(deg) { return ['N','NE','E','SE','S','SW','W','NW'][Math.round(((deg % 360) / 45)) % 8]; }

async function getElevationSingle(lat, lon) {
    const key = `${Math.round(lat*1000)},${Math.round(lon*1000)}`;
    const cached = elevationCache[key];
    if (cached && Date.now() - cached.ts < ELEVATION_CACHE_MS) return cached.val;
    return enqueueApiCall(async () => {
        try {
            const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
            if (!r.ok) return null;
            const d = await r.json();
            if (d.elevation?.length > 0 && !isNaN(d.elevation[0])) { const val = Number(d.elevation[0]); elevationCache[key] = { val, ts: Date.now() }; return val; }
        } catch {} return null;
    });
}

async function computeSlopeAspect(lat, lon) {
    const { mPerDegLat, mPerDegLon } = metersPerDegree(lat);
    const d = SLOPE_SAMPLE_OFFSET_DEG;
    const [zN,zS,zE,zW] = await Promise.all([getElevationSingle(lat+d,lon),getElevationSingle(lat-d,lon),getElevationSingle(lat,lon+d),getElevationSingle(lat,lon-d)]);
    if ([zN,zS,zE,zW].some(z => z === null)) return null;
    const dzdy = (zN-zS)/(2*d*mPerDegLat), dzdx = (zE-zW)/(2*d*mPerDegLon);
    const slopeDeg = Math.round(Math.atan(Math.sqrt(dzdx*dzdx+dzdy*dzdy))*180/Math.PI);
    let aspectDeg = Math.round(Math.atan2(dzdy,-dzdx)*180/Math.PI); if (aspectDeg < 0) aspectDeg += 360;
    return { slopeDeg, aspectDeg, aspectCard: degToCardinal(aspectDeg) };
}

// ==================== WEATHER FETCHING ====================
async function fetchTemperature(el) {
    const lat = el.center?.lat ?? el.lat, lon = el.center?.lon ?? el.lon;
    if (!lat || !lon) return false;
    return enqueueApiCall(async () => {
        try {
            const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,snowfall,snow_depth&daily=temperature_2m_max,temperature_2m_min&past_days=2&forecast_days=1&timezone=auto`;
            const r = await fetch(url);
            if (!r.ok) return false;
            const data = await r.json();
            const hourly = data.hourly || {}, temps = hourly.temperature_2m || [], snowfall = hourly.snowfall || [], snowDepth = hourly.snow_depth || [];
            const daily = data.daily || {};
            if (temps.length > 0) { const last = temps[temps.length-1]; if (last != null && !isNaN(last)) { el.tags.temperature = Math.round(last); el.tags.temperature_updated_at = Date.now(); } }
            const todayStr = new Date().toISOString().split('T')[0];
            const dayList = daily.time || [];
            const idx = dayList.indexOf(todayStr);
            const pick = (arr) => Array.isArray(arr) ? (idx >= 0 && idx < arr.length ? arr[idx] : arr[arr.length-1]) : null;
            const vMin = pick(daily.temperature_2m_min), vMax = pick(daily.temperature_2m_max);
            if (vMin != null && !isNaN(vMin)) el.tags.temperature_min = Math.round(vMin);
            if (vMax != null && !isNaN(vMax)) el.tags.temperature_max = Math.round(vMax);
            // Snow
            let recentSnowfallSum = 0;
            if (snowfall.length > 0) { for (let i = Math.max(0,snowfall.length-SNOW_RECENT_HOURS); i < snowfall.length; i++) { const v = snowfall[i]; if (v != null && !isNaN(v)) recentSnowfallSum += v; } }
            let lastSnowDepth = null;
            if (snowDepth.length > 0) { const v = snowDepth[snowDepth.length-1]; if (v != null && !isNaN(v)) lastSnowDepth = Math.round(v); }
            let recentMinTemp = null;
            if (temps.length > 0) { for (let i = Math.max(0,temps.length-SNOW_RECENT_HOURS); i < temps.length; i++) { const v = temps[i]; if (v != null && !isNaN(v)) recentMinTemp = recentMinTemp === null ? v : Math.min(recentMinTemp, v); } if (recentMinTemp !== null) recentMinTemp = Math.round(recentMinTemp); }
            const ele = parseInt(el.tags?.ele ?? 0) || 0;
            let snowDetected = false, confidence = 'basso';
            if (lastSnowDepth !== null && lastSnowDepth >= SNOW_DEPTH_THRESHOLD_CM) { snowDetected = true; confidence = 'alto'; }
            else if (recentSnowfallSum >= SNOWFALL_RECENT_THRESHOLD_MM && recentMinTemp !== null && recentMinTemp <= TEMP_FREEZE_THRESHOLD_C) { snowDetected = true; confidence = 'medio'; }
            else if (ele >= ALTITUDE_SNOW_SUPPORT_M && recentMinTemp !== null && recentMinTemp <= TEMP_NEAR_FREEZE_C) { snowDetected = true; confidence = 'basso'; }
            el.tags.snow = snowDetected; el.tags.snow_confidence = confidence;
            if (lastSnowDepth !== null) el.tags.snow_depth_cm = lastSnowDepth;
            el.tags.snowfall_48h_mm = Math.round(recentSnowfallSum);
            if (recentMinTemp !== null) el.tags.temp_min_48h = recentMinTemp;
            el.tags.snow_updated_at = Date.now();
            return true;
        } catch { return false; }
    });
}

// ==================== STORAGE ====================
let lastSaveTime = 0;
async function saveBivacchiToStorage(data) {
    if (Date.now() - lastSaveTime < 2000) return;
    lastSaveTime = Date.now();
    if (typeof DBService !== 'undefined') { try { await DBService.saveBivacchi(data); } catch {} }
    try { localStorage.setItem('bivacchi-data', JSON.stringify(data)); } catch {}
}

// ==================== GLOBALS ====================
let rawData = [];
let map;
let markers = [];
let markerClusterGroup = null;
let currentUser = null;
let addressMap = null;
let selectedCoords = null;
let dataLoaded = false;
let mapInitialized = false;
let mapFitPending = false;
let homeMarker = null;
let locationMarker = null;
let locationCircle = null;
let pendingUIUpdate = false;
let currentView = 'map'; // 'map' or 'list'
let selectedBivacco = null; // Currently selected bivacco for detail panel
let currentMapLayer = 'standard';
let radarInitialized = false;
let radarActive = false;
let localFavorites = JSON.parse(localStorage.getItem('bivacchi_local_favs') || '[]');
let localNotes = JSON.parse(localStorage.getItem('bivacchi_local_notes') || '{}');
let geocodingTimeout = null;

const throttledUIUpdate = debounce(() => { if (pendingUIUpdate) { aggiornaInterfaccia(); pendingUIUpdate = false; } }, 2000);

const LIST_PAGE_SIZE = 50;
let currentListPage = 1;
let currentFilteredData = [];

const listContainer = document.getElementById('bivacchi-list');

// ==================== MAP LAYERS ====================
let osmLayer, satLayer;
function initMapLayers() {
    osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OSM',
        maxZoom: 19,
        maxNativeZoom: 19,
        keepBuffer: 6,
        updateWhenZooming: false,
        updateWhenIdle: true,
        errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='
    });
    satLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri',
        maxZoom: 19,
        maxNativeZoom: 18,
        keepBuffer: 4,
        updateWhenZooming: false,
        updateWhenIdle: true,
        errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg=='
    });
}

function switchMapLayer(layerName) {
    if (layerName === currentMapLayer) return;
    if (layerName === 'satellite') { map.removeLayer(osmLayer); satLayer.addTo(map); document.querySelector('.leaflet-tile-pane').style.filter = 'none'; }
    else { map.removeLayer(satLayer); osmLayer.addTo(map); document.querySelector('.leaflet-tile-pane').style.filter = 'brightness(0.85) contrast(1.1) saturate(0.9)'; }
    currentMapLayer = layerName;
    document.querySelectorAll('.layer-option').forEach(btn => btn.classList.toggle('active', btn.dataset.layer === layerName));
}

// ==================== GEOCODING SEARCH ====================
function setupSearch() {
    const input = document.getElementById('search-input');
    const suggestions = document.getElementById('search-suggestions');
    const spinner = document.getElementById('search-spinner');

    input.addEventListener('input', () => {
        const q = input.value.trim();
        clearTimeout(geocodingTimeout);
        if (q.length < 2) { suggestions.classList.remove('open'); return; }

        // First show matching bivacchi instantly
        const bivMatches = rawData.filter(el => (el.tags?.name || '').toLowerCase().includes(q.toLowerCase())).slice(0, 5);
        let html = '';
        if (bivMatches.length > 0) {
            html += '<div class="search-divider">Bivacchi</div>';
            bivMatches.forEach(el => {
                html += `<div class="search-suggestion" data-type="bivacco" data-id="${el.id}">
                    <span class="ss-icon">🏔️</span>
                    <div><div class="ss-name">${escapeHtml(el.tags.name)}</div><div class="ss-detail">${el.tags.ele || '?'}m</div></div>
                </div>`;
            });
        }
        suggestions.innerHTML = html;
        if (html) suggestions.classList.add('open');

        // Debounce Nominatim geocoding
        spinner.style.display = 'flex';
        geocodingTimeout = setTimeout(async () => {
            try {
                const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&countrycodes=it&accept-language=it`);
                const results = await r.json();
                if (results.length > 0) {
                    html += '<div class="search-divider">Luoghi</div>';
                    results.forEach(r => {
                        html += `<div class="search-suggestion" data-type="place" data-lat="${r.lat}" data-lon="${r.lon}">
                            <span class="ss-icon">📍</span>
                            <div><div class="ss-name">${escapeHtml(r.display_name.split(',')[0])}</div><div class="ss-detail">${escapeHtml(r.display_name.split(',').slice(1,3).join(','))}</div></div>
                        </div>`;
                    });
                    suggestions.innerHTML = html;
                    suggestions.classList.add('open');
                }
            } catch {} finally { spinner.style.display = 'none'; }
        }, 400);
    });

    suggestions.addEventListener('click', (e) => {
        const item = e.target.closest('.search-suggestion');
        if (!item) return;
        suggestions.classList.remove('open');
        input.value = '';
        if (item.dataset.type === 'bivacco') {
            const biv = rawData.find(el => el.id == item.dataset.id);
            if (biv) mostraDettagli(biv);
        } else if (item.dataset.type === 'place') {
            const lat = parseFloat(item.dataset.lat), lon = parseFloat(item.dataset.lon);
            switchToMapView();
            map.setView([lat, lon], 14);
        }
    });

    // Close on click outside
    document.addEventListener('click', (e) => { if (!document.getElementById('search-container').contains(e.target)) suggestions.classList.remove('open'); });
}

// ==================== VIEW TOGGLE ====================
function switchToMapView() {
    currentView = 'map';
    document.getElementById('map-view').classList.add('active');
    document.getElementById('list-view').classList.remove('active');
    document.getElementById('icon-view-list').style.display = '';
    document.getElementById('icon-view-map').style.display = 'none';
    setTimeout(() => { if (map) { map.invalidateSize(); if (mapFitPending && markers.length > 0 && markerClusterGroup) { map.fitBounds(markerClusterGroup.getBounds().pad(0.1)); mapInitialized = true; mapFitPending = false; } } }, 100);
}

function switchToListView() {
    currentView = 'list';
    document.getElementById('list-view').classList.add('active');
    document.getElementById('map-view').classList.remove('active');
    document.getElementById('icon-view-list').style.display = 'none';
    document.getElementById('icon-view-map').style.display = '';
}

// ==================== FILTER SIDEBAR ====================
function openFilters() { document.getElementById('sidebar-filters').classList.add('open'); }
function closeFilters() { document.getElementById('sidebar-filters').classList.remove('open'); }

// ==================== FILTER BADGES ====================
function updateFilterBadges() {
    const badges = document.getElementById('filter-badges');
    const minAlt = parseInt(document.getElementById('filter-alt-min').value), maxAlt = parseInt(document.getElementById('filter-alt-max').value);
    const minTemp = parseInt(document.getElementById('filter-temp-min').value), maxTemp = parseInt(document.getElementById('filter-temp-max').value);
    let html = '';
    if (minAlt > 0 || maxAlt < 4800) html += `<span class="filter-badge" onclick="resetFilter('alt')">🏔️ ${minAlt}-${maxAlt}m ✕</span>`;
    if (minTemp > -30 || maxTemp < 40) html += `<span class="filter-badge" onclick="resetFilter('temp')">🌡️ ${minTemp}°/${maxTemp}° ✕</span>`;
    // Snow badge
    const snowYesActive = document.getElementById('filter-snow-yes')?.classList.contains('active');
    const snowNoActive = document.getElementById('filter-snow-no')?.classList.contains('active');
    if (snowYesActive) html += `<span class="filter-badge" onclick="resetFilter('snow')">❄️ Neve ✕</span>`;
    if (snowNoActive) html += `<span class="filter-badge" onclick="resetFilter('snow')">☀️ No neve ✕</span>`;
    // Aspect badge
    const activeAspectChips = document.querySelectorAll('#aspect-chips .filter-chip.active:not([data-aspect=all])');
    if (activeAspectChips.length > 0) {
        const aspects = [...activeAspectChips].map(c => c.dataset.aspect).join(',');
        html += `<span class="filter-badge" onclick="resetFilter('aspect')">🧭 ${aspects} ✕</span>`;
    }
    // Always show "Bivacco" badge when tracks are loaded (MountPro style)
    if (typeof GPXService !== 'undefined' && GPXService.tracks.length > 0) {
        html += `<span class="filter-badge badge-type">⛺ Bivacco</span>`;
    }
    const gpxSwitch = document.getElementById('gpx-prox-switch');
    if (gpxSwitch?.classList.contains('active')) {
        html += `<span class="filter-badge badge-gpx" onclick="resetFilter('gpx')">🔗 Sul Percorso ✕</span>`;
    }
    badges.innerHTML = html;
}

function resetFilter(type) {
    if (type === 'alt') { document.getElementById('filter-alt-min').value = 0; document.getElementById('filter-alt-max').value = 4800; }
    if (type === 'temp') { document.getElementById('filter-temp-min').value = -30; document.getElementById('filter-temp-max').value = 40; }
    if (type === 'snow') { document.querySelectorAll('[data-snow]').forEach(c => c.classList.remove('active')); document.getElementById('filter-snow-all')?.classList.add('active'); }
    if (type === 'aspect') { document.querySelectorAll('#aspect-chips .filter-chip').forEach(c => c.classList.remove('active')); document.querySelector('#aspect-chips [data-aspect="all"]')?.classList.add('active'); }
    if (type === 'gpx') { document.getElementById('gpx-prox-switch').classList.remove('active'); }
    updateFilterDisplays();
    aggiornaInterfaccia();
}

function updateFilterDisplays() {
    const minAltEl = document.getElementById('filter-alt-min'), maxAltEl = document.getElementById('filter-alt-max');
    const minTempEl = document.getElementById('filter-temp-min'), maxTempEl = document.getElementById('filter-temp-max');
    const minAlt = minAltEl.value, maxAlt = maxAltEl.value;
    const minTemp = minTempEl.value, maxTemp = maxTempEl.value;
    document.getElementById('alt-range-display').textContent = `${minAlt}m \u2013 ${maxAlt}m`;
    document.getElementById('temp-range-display').textContent = `${minTemp}\u00B0C \u2013 ${maxTemp}\u00B0C`;
    // Toggle at-max so max thumb stays on top when min reaches the maximum
    minAltEl.classList.toggle('at-max', parseInt(minAlt) >= parseInt(maxAltEl.max));
    minTempEl.classList.toggle('at-max', parseInt(minTemp) >= parseInt(maxTempEl.max));
    const distEl = document.getElementById('filter-dist-max');
    if (distEl) document.getElementById('dist-display').textContent = `${distEl.value} km`;
    const gpxEl = document.getElementById('filter-gpx-proximity');
    if (gpxEl) document.getElementById('gpx-prox-display').textContent = `${parseFloat(gpxEl.value).toFixed(1)} km`;
    updateFilterBadges();
}

// ==================== FAVORITES (localStorage, no auth required) ====================
function isLocalFavorite(id) { return localFavorites.includes(String(id)); }
function toggleLocalFavorite(id) {
    const sid = String(id);
    if (localFavorites.includes(sid)) localFavorites = localFavorites.filter(x => x !== sid);
    else localFavorites.push(sid);
    localStorage.setItem('bivacchi_local_favs', JSON.stringify(localFavorites));
}

// ==================== NOTES (localStorage per bivacco) ====================
function getNote(bivId) { return localNotes[String(bivId)] || ''; }
function saveNote(bivId, text) {
    if (text.trim()) localNotes[String(bivId)] = text.trim();
    else delete localNotes[String(bivId)];
    localStorage.setItem('bivacchi_local_notes', JSON.stringify(localNotes));
}

// ==================== SIGNAL ESTIMATION ====================
function estimateSignal(el) {
    const ele = parseInt(el.tags?.ele || 0);
    const slope = el.tags?.slope_deg || 0;
    const aspect = el.tags?.aspect_card || '';
    // Simple heuristic: lower altitude = better, ridge (low slope at high alt) = better, valley = worse
    let score = 3; // 0-5
    if (ele < 1500) score = 4;
    else if (ele < 2000) score = 3;
    else if (ele < 2500) score = 2;
    else if (ele < 3000) score = 1;
    else score = 0;
    // Ridge bonus
    if (slope < 15 && ele > 2000) score = Math.min(5, score + 1);
    // Valley penalty
    if (slope > 30) score = Math.max(0, score - 1);
    return score;
}

function renderSignalBars(score) {
    const heights = [4,7,10,13,16];
    return `<div class="signal-indicator">${heights.map((h,i) => `<div class="signal-bar${i < score ? ' active' : ''}" style="height:${h}px"></div>`).join('')}</div>`;
}

// ==================== WEATHER WIDGET ====================
async function updateWeatherWidget() {
    if (!map) return;
    const center = map.getCenter();
    const widget = document.getElementById('weather-widget');
    try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${center.lat}&longitude=${center.lng}&current=temperature_2m,relative_humidity_2m,weather_code`);
        const d = await r.json();
        if (d.current) {
            widget.style.display = 'flex';
            document.getElementById('ww-temp').textContent = `${Math.round(d.current.temperature_2m)}\u00B0C`;
            document.getElementById('ww-hum').textContent = `${d.current.relative_humidity_2m}%`;
            const code = d.current.weather_code;
            let icon = '\u2600\uFE0F';
            if (code >= 1 && code <= 3) icon = '\u26C5';
            else if (code >= 45 && code <= 48) icon = '\uD83C\uDF2B\uFE0F';
            else if (code >= 51 && code <= 67) icon = '\uD83C\uDF27\uFE0F';
            else if (code >= 71 && code <= 77) icon = '\u2744\uFE0F';
            else if (code >= 80 && code <= 82) icon = '\uD83C\uDF26\uFE0F';
            else if (code >= 95) icon = '\u26C8\uFE0F';
            document.getElementById('ww-icon').textContent = icon;
        }
    } catch(e) {
        console.warn('Weather widget fetch failed:', e);
    }
}

// ==================== WEATHER PANEL (detailed) ====================
async function openWeatherPanel() {
    const panel = document.getElementById('weather-panel');
    const body = document.getElementById('weather-panel-body');
    panel.style.display = 'flex';
    body.innerHTML = '<p class="placeholder-text">Caricamento meteo dettagliato...</p>';
    const center = map.getCenter();
    try {
        const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${center.lat}&longitude=${center.lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,surface_pressure,apparent_temperature,cloud_cover,precipitation&hourly=temperature_2m,weather_code,precipitation_probability,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_sum&timezone=auto&forecast_days=3`);
        const d = await r.json();
        const c = d.current || {};
        let html = `<div class="stat-grid" style="margin-bottom:16px">
            <div class="stat-box"><div class="stat-label">Temperatura</div><div class="stat-value accent">${Math.round(c.temperature_2m || 0)}\u00B0C</div></div>
            <div class="stat-box"><div class="stat-label">Percepita</div><div class="stat-value">${Math.round(c.apparent_temperature || 0)}\u00B0C</div></div>
            <div class="stat-box"><div class="stat-label">Umidit\u00E0</div><div class="stat-value blue">${c.relative_humidity_2m || 0}%</div></div>
            <div class="stat-box"><div class="stat-label">Vento</div><div class="stat-value">${Math.round(c.wind_speed_10m || 0)} km/h</div></div>
            <div class="stat-box"><div class="stat-label">Pressione</div><div class="stat-value">${Math.round(c.surface_pressure || 0)} hPa</div></div>
            <div class="stat-box"><div class="stat-label">Nuvolosit\u00E0</div><div class="stat-value">${c.cloud_cover || 0}%</div></div>
        </div>`;
        // Hourly
        const hourly = d.hourly || {};
        if (hourly.time?.length > 0) {
            html += '<h3 style="font-size:13px;font-weight:600;margin-bottom:8px">Previsioni orarie</h3><div class="hourly-scroll">';
            const now = new Date();
            const startIdx = hourly.time.findIndex(t => new Date(t) >= now);
            for (let i = Math.max(0,startIdx); i < Math.min(startIdx+24, hourly.time.length); i++) {
                const time = new Date(hourly.time[i]);
                const wc = hourly.weather_code?.[i] || 0;
                let ic = '\u2600\uFE0F';
                if (wc >= 1 && wc <= 3) ic = '\u26C5'; else if (wc >= 51 && wc <= 67) ic = '\uD83C\uDF27\uFE0F'; else if (wc >= 71 && wc <= 77) ic = '\u2744\uFE0F'; else if (wc >= 95) ic = '\u26C8\uFE0F';
                html += `<div class="hourly-item"><div class="hourly-time">${String(time.getHours()).padStart(2,'0')}:00</div><div class="hourly-icon">${ic}</div><div class="hourly-temp">${Math.round(hourly.temperature_2m[i])}\u00B0</div></div>`;
            }
            html += '</div>';
        }
        // Daily
        const daily = d.daily || {};
        if (daily.time?.length > 0) {
            html += '<h3 style="font-size:13px;font-weight:600;margin:16px 0 8px">Previsioni giornaliere</h3>';
            daily.time.forEach((t,i) => {
                const date = new Date(t);
                const dayName = date.toLocaleDateString('it-IT', { weekday:'short', day:'numeric' });
                html += `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border-bottom:1px solid var(--border-subtle);font-size:13px">
                    <span style="color:var(--text-secondary)">${dayName}</span>
                    <span><span style="color:var(--info)">${Math.round(daily.temperature_2m_min?.[i]||0)}\u00B0</span> / <span style="color:var(--accent)">${Math.round(daily.temperature_2m_max?.[i]||0)}\u00B0</span></span>
                    <span style="color:var(--text-muted)">${daily.precipitation_sum?.[i] ? daily.precipitation_sum[i]+'mm' : '-'}</span>
                </div>`;
            });
        }
        body.innerHTML = html;
    } catch (e) { body.innerHTML = '<p class="placeholder-text">Errore nel caricamento meteo.</p>'; }
}

// ==================== CUSTOM MARKERS ====================
function createBivaccoIcon(el, isSelected = false) {
    const cls = isSelected ? 'biv-marker biv-marker-selected' : 'biv-marker';
    return L.divIcon({
        className: cls,
        html: `<div class="biv-marker-pin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 22l9-20 9 20"/><path d="M7.5 14h9"/></svg></div>`,
        iconSize: isSelected ? [36, 36] : [28, 28],
        iconAnchor: isSelected ? [18, 36] : [14, 28],
        popupAnchor: [0, isSelected ? -36 : -28]
    });
}

// ==================== GEOLOCATION ====================
function locateUser() {
    if (!navigator.geolocation) return;
    const btn = document.getElementById('btn-locate');
    btn.classList.add('active');
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const { latitude: lat, longitude: lon, heading } = pos.coords;
            if (locationMarker) map.removeLayer(locationMarker);
            if (locationCircle) map.removeLayer(locationCircle);
            locationCircle = L.circle([lat, lon], { radius: pos.coords.accuracy, color: 'rgba(59,130,246,0.3)', fillColor: 'rgba(59,130,246,0.1)', fillOpacity: 0.5, weight: 1 }).addTo(map);
            const headingHtml = heading ? `<div class="loc-marker-heading"></div>` : '';
            locationMarker = L.marker([lat, lon], {
                icon: L.divIcon({ className: '', html: `<div style="position:relative">${headingHtml}<div class="loc-marker"></div></div>`, iconSize: [18, 18], iconAnchor: [9, 9] })
            }).addTo(map);
            map.setView([lat, lon], 14);
            setTimeout(() => btn.classList.remove('active'), 1000);
        },
        () => { btn.classList.remove('active'); alert('Impossibile ottenere la posizione'); },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ==================== DATA LOADING ====================
async function caricaDatiNordEst() {
    let cachedData = null;
    try { if (typeof DBService !== 'undefined') cachedData = await DBService.getBivacchi(); } catch {}
    if (!cachedData?.length) { try { cachedData = JSON.parse(localStorage.getItem('bivacchi-data')); } catch {} }
    if (cachedData?.length > 0) {
        rawData = cachedData;
        dataLoaded = true;
        aggiornaInterfaccia();
        cacheBivacchiInSW(rawData);
        if (isOnline) BackgroundDataManager.startAllJobs(rawData);
    }
    if (isOnline) {
        try {
            const res = await fetch(API_BASE_URL + '/api/bivacchi');
            if (res.ok) {
                const data = await res.json();
                if (data.length > 0) { rawData = data; saveBivacchiToStorage(rawData); cacheBivacchiInSW(rawData); dataLoaded = true; aggiornaInterfaccia(); BackgroundDataManager.startAllJobs(rawData); return; }
            }
        } catch (e) { if (rawData.length > 0) return; }
    } else { if (rawData.length > 0) return; }
    if (!isOnline) { listContainer.innerHTML = '<p class="placeholder-text">\uD83D\uDCF4 Nessun dato in cache. Connettiti per caricare.</p>'; return; }
    listContainer.innerHTML = '<p class="placeholder-text">Caricamento bivacchi...</p>';
    const query = `[out:json][timeout:180];(area[name="Veneto"][admin_level="4"];area[name="Trentino-Alto Adige"][admin_level="4"];area[name="Friuli-Venezia Giulia"][admin_level="4"];)->.r;(node["tourism"~"alpine_hut|wilderness_hut"]["name"~"bivacco",i](area.r);way["tourism"~"alpine_hut|wilderness_hut"]["name"~"bivacco",i](area.r);node["amenity"="shelter"]["name"~"bivacco",i](area.r);way["amenity"="shelter"]["name"~"bivacco",i](area.r);node["shelter_type"~"bivouac|basic_hut"](area.r);way["shelter_type"~"bivouac|basic_hut"](area.r););out center;`;
    const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
    for (const baseUrl of urls) {
        try {
            const res = await fetch(`${baseUrl}?data=${encodeURIComponent(query)}`);
            if (!res.ok) continue;
            const data = await res.json();
            rawData = data.elements.filter(el => el.tags?.name?.trim());
            dataLoaded = true; aggiornaInterfaccia();
            fetch(API_BASE_URL+'/api/bivacchi', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(rawData) }).catch(() => {});
            BackgroundDataManager.startAllJobs(rawData);
            return;
        } catch {}
    }
    listContainer.innerHTML = '<p class="placeholder-text" style="color:var(--danger)">Errore caricamento. <button onclick="caricaDatiNordEst()">Riprova</button></p>';
}

// ==================== INTERFACE UPDATE ====================
function aggiornaInterfaccia() {
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const minAlt = parseInt(document.getElementById('filter-alt-min').value);
    const maxAlt = parseInt(document.getElementById('filter-alt-max').value);
    const minTemp = parseInt(document.getElementById('filter-temp-min').value);
    const maxTemp = parseInt(document.getElementById('filter-temp-max').value);
    const maxDist = parseInt(document.getElementById('filter-dist-max').value);
    const sortBy = document.getElementById('sort-by').value;
    const gpxProxActive = document.getElementById('gpx-prox-switch')?.classList.contains('active');
    const gpxProxDist = parseFloat(document.getElementById('filter-gpx-proximity')?.value || 2);

    // Detect if temperature filter has been changed from defaults
    const tempFilterActive = (minTemp > -30 || maxTemp < 40);

    // Snow filter
    const snowAll = document.getElementById('filter-snow-all');
    const snowYes = document.getElementById('filter-snow-yes');
    const snowNo = document.getElementById('filter-snow-no');
    let snowFilter = 'all';
    if (snowYes?.classList.contains('active')) snowFilter = 'yes';
    else if (snowNo?.classList.contains('active')) snowFilter = 'no';

    // Aspect filter
    const activeAspects = [];
    document.querySelectorAll('#aspect-chips .filter-chip.active').forEach(chip => {
        activeAspects.push(chip.dataset.aspect);
    });
    const aspectFilterActive = !activeAspects.includes('all') && activeAspects.length > 0;

    // Show distance filter if user has home address
    if (currentUser?.home_address) {
        document.getElementById('distance-filter-section').style.display = '';
        document.querySelectorAll('.dist-sort-opt').forEach(o => o.style.display = '');
    }

    const uniqueIds = new Set();
    const filtrati = rawData.filter(el => {
        if (uniqueIds.has(el.id)) return false;
        const nome = (el.tags?.name || '').toLowerCase();
        const alt = parseInt(el.tags?.ele || 0);
        if (!nome.includes(searchTerm)) return false;
        if (alt < minAlt || alt > maxAlt) return false;
        // Temperature filter: if user changed range, exclude bivacchi without temp data
        if (tempFilterActive) {
            if (el.tags?.temperature === undefined) return false;
            const t = parseFloat(el.tags.temperature);
            if (t < minTemp || t > maxTemp) return false;
        }
        // Snow filter
        if (snowFilter === 'yes' && el.tags?.snow !== true) return false;
        if (snowFilter === 'no' && el.tags?.snow === true) return false;
        // Aspect/Exposure filter
        if (aspectFilterActive) {
            const elAspect = el.tags?.aspect_card || '';
            if (!elAspect || !activeAspects.includes(elAspect)) return false;
        }
        if (currentUser?.home_address) { const d = calculateDistance(currentUser.home_address.lat, currentUser.home_address.lon, el.center?.lat ?? el.lat, el.center?.lon ?? el.lon); if (d > maxDist) return false; }
        if (gpxProxActive && typeof GPXService !== 'undefined' && GPXService.tracks.length > 0) {
            const elLat = el.center?.lat ?? el.lat, elLon = el.center?.lon ?? el.lon;
            let nearTrack = false;
            for (const track of GPXService.tracks) {
                for (const pt of track.latlngs) {
                    if (calculateDistance(pt[0], pt[1], elLat, elLon) <= gpxProxDist) { nearTrack = true; break; }
                }
                if (nearTrack) break;
            }
            if (!nearTrack) return false;
        }
        uniqueIds.add(el.id);
        return true;
    });

    // Sort
    filtrati.sort((a, b) => {
        switch(sortBy) {
            case 'nome': return (a.tags.name||'').localeCompare(b.tags.name||'');
            case 'nome-desc': return (b.tags.name||'').localeCompare(a.tags.name||'');
            case 'alt-asc': return parseInt(a.tags.ele||0) - parseInt(b.tags.ele||0);
            case 'alt-desc': return parseInt(b.tags.ele||0) - parseInt(a.tags.ele||0);
            case 'temp-asc': return parseInt(a.tags.temperature||0) - parseInt(b.tags.temperature||0);
            case 'temp-desc': return parseInt(b.tags.temperature||0) - parseInt(a.tags.temperature||0);
            case 'dist-asc': case 'dist-desc':
                if (!currentUser?.home_address) return 0;
                const dA = calculateDistance(currentUser.home_address.lat, currentUser.home_address.lon, a.center?.lat??a.lat, a.center?.lon??a.lon);
                const dB = calculateDistance(currentUser.home_address.lat, currentUser.home_address.lon, b.center?.lat??b.lat, b.center?.lon??b.lon);
                return sortBy === 'dist-asc' ? dA-dB : dB-dA;
            default: return 0;
        }
    });

    currentFilteredData = filtrati;
    currentListPage = 1;
    renderListPage();
    updateMap(filtrati);
    updateFilterBadges();
}

function getBivaccoTypeBadge(el) {
    const st = el.tags?.shelter_type;
    const t = el.tags?.tourism;
    if (st === 'basic_hut' || st === 'bivouac' || t === 'wilderness_hut') return 'BIVACCO';
    if (t === 'alpine_hut') return 'RIFUGIO';
    if (st === 'rock_shelter') return 'RIPARO';
    if (st === 'weather_shelter') return 'RICOVERO';
    return 'BIVACCO';
}

function getBivaccoDescription(el) {
    if (el.tags?.description) return el.tags.description;
    if (el.tags?.['description:it']) return el.tags['description:it'];
    // Build a generic description from available tags
    const parts = [];
    const typeName = getBivaccoTypeBadge(el);
    if (typeName === 'BIVACCO') parts.push('Bivacco non custodito.');
    else if (typeName === 'RIFUGIO') parts.push('Rifugio alpino.');
    else parts.push('Punto di appoggio.');
    return parts.join(' ');
}

function getCapacityChip(el) {
    const cap = el.tags?.capacity || el.tags?.beds;
    if (!cap) return { icon: 'tent', label: 'N/D' };
    return { icon: 'bed', label: `${cap} Posti` };
}

function getHeatingChip(el) {
    if (el.tags?.fireplace === 'yes') return { icon: 'fire', label: 'Stufa' };
    if (el.tags?.stove === 'yes') return { icon: 'fire', label: 'Stufa' };
    return { icon: 'house', label: 'Chiuso' };
}

function getManagedChip(el) {
    if (el.tags?.operator) return { icon: 'grid', label: 'Gestito' };
    return { icon: 'grid', label: 'Non gestito' };
}

function getWaterChip(el) {
    if (el.tags?.drinking_water === 'yes' || el.tags?.water_source) return { icon: 'water', label: 'Acqua' };
    return { icon: 'water-off', label: 'No acqua' };
}

function chipIconSVG(type) {
    const icons = {
        tent: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 20 L12 4 L22 20Z"/><path d="M12 20V12"/></svg>',
        bed: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>',
        fire: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14 0-5.5 3-6.5 1 1.5 2 3.5 2 5.5 0 2.5-1.5 3.5-2 4 .5.5 1 1 1 2.5a2.5 2.5 0 0 1-5 0"/></svg>',
        house: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
        grid: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
        water: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
        'water-off': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z" opacity=".4"/><line x1="4" y1="4" x2="20" y2="20" stroke-width="2"/></svg>',
    };
    return icons[type] || '';
}

function renderListPage() {
    const endIdx = currentListPage * LIST_PAGE_SIZE;
    const items = currentFilteredData.slice(0, endIdx);
    listContainer.innerHTML = '';
    if (items.length === 0) { listContainer.innerHTML = '<p class="placeholder-text">Nessun bivacco trovato.</p>'; return; }

    const frag = document.createDocumentFragment();
    // Counter
    const counter = document.createElement('div');
    counter.className = 'list-counter';
    counter.textContent = `${Math.min(endIdx, currentFilteredData.length)} di ${currentFilteredData.length} bivacchi`;
    frag.appendChild(counter);

    items.forEach(el => {
        const card = document.createElement('div');
        card.className = 'biv-card';
        const alt = el.tags?.ele || '0';
        const isFav = isLocalFavorite(el.id) || (currentUser?.favorites?.includes(String(el.id)));
        const typeBadge = getBivaccoTypeBadge(el);
        const desc = getBivaccoDescription(el);
        const chipCap = getCapacityChip(el);
        const chipHeat = getHeatingChip(el);
        const chipManaged = getManagedChip(el);
        const chipWater = getWaterChip(el);

        card.innerHTML = `
            <div class="biv-card-header">
                <h3 class="biv-card-name">${escapeHtml(el.tags.name || 'Bivacco')}</h3>
                <button class="biv-card-fav" onclick="event.stopPropagation();toggleFavorite('${el.id}')" aria-label="Preferito">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="${isFav ? 'var(--danger)' : 'none'}" stroke="${isFav ? 'var(--danger)' : 'var(--text-muted)'}" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                </button>
            </div>
            <div class="biv-card-meta">
                <span class="biv-type-badge">${typeBadge}</span>
                <span class="biv-alt-label">${alt}m</span>
            </div>
            <p class="biv-card-desc">${escapeHtml(desc).substring(0, 120)}${desc.length > 120 ? '...' : ''}</p>
            <div class="biv-card-chips">
                <div class="biv-chip">${chipIconSVG(chipCap.icon)}<span>${chipCap.label}</span></div>
                <div class="biv-chip biv-chip-accent">${chipIconSVG(chipHeat.icon)}<span>${chipHeat.label}</span></div>
                <div class="biv-chip">${chipIconSVG(chipManaged.icon)}<span>${chipManaged.label}</span></div>
                <div class="biv-chip">${chipIconSVG(chipWater.icon)}<span>${chipWater.label}</span></div>
            </div>`;
        card.onclick = () => mostraDettagli(el);
        frag.appendChild(card);
    });

    if (endIdx < currentFilteredData.length) {
        const btn = document.createElement('button');
        btn.className = 'load-more-btn';
        btn.textContent = `Mostra altri (${currentFilteredData.length - endIdx} rimanenti)`;
        btn.onclick = () => { currentListPage++; renderListPage(); };
        frag.appendChild(btn);
    }
    listContainer.appendChild(frag);
}

// ==================== MAP UPDATE ====================
function getSignalLabel(score) {
    if (score >= 4) return '4G';
    if (score >= 3) return '3G';
    if (score >= 2) return '2G';
    if (score >= 1) return 'E';
    return '--';
}

function buildPopupHTML(el) {
    const alt = el.tags?.ele || '0';
    const typeBadge = getBivaccoTypeBadge(el);
    const signal = estimateSignal(el);
    const sigLabel = getSignalLabel(signal);
    const isFav = isLocalFavorite(el.id) || (currentUser?.favorites?.includes(String(el.id)));
    const sigBars = [4,7,10,13,16].map((h,i) =>
        `<div style="width:3px;height:${h}px;border-radius:1px;background:${i < signal ? 'var(--success)' : 'var(--bg-hover)'}"></div>`
    ).join('');

    return `<div class="map-popup">
        <div class="map-popup-header">
            <span class="biv-type-badge">${typeBadge}</span>
            <span class="map-popup-alt">${alt}m</span>
        </div>
        <div class="map-popup-name">${escapeHtml(el.tags?.name || 'Bivacco')}</div>
        <div class="map-popup-signal">
            <div style="display:flex;align-items:flex-end;gap:2px;height:16px">${sigBars}</div>
            <span class="map-popup-sig-label">${sigLabel}</span>
            <span class="map-popup-sig-note">Stimato</span>
        </div>
        <div class="map-popup-actions">
            <button class="map-popup-btn" onclick="mostraDettagli(window._popupBivacchi['${el.id}'])">Vedi Dettagli</button>
            <button class="map-popup-fav" onclick="event.stopPropagation();toggleFavorite('${el.id}')" aria-label="Preferito">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="${isFav ? 'var(--danger)' : 'none'}" stroke="${isFav ? 'var(--danger)' : 'var(--text-muted)'}" stroke-width="1.8"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
            </button>
        </div>
    </div>`;
}

// Store references so popup buttons can access bivacco data
window._popupBivacchi = {};

function updateMap(filtrati) {
    if (markerClusterGroup) map.removeLayer(markerClusterGroup);
    markerClusterGroup = L.markerClusterGroup({ chunkedLoading: true, showCoverageOnHover: false, maxClusterRadius: 50, disableClusteringAtZoom: 16, animate: false });
    markers = [];
    window._popupBivacchi = {};
    if (currentUser?.home_address) {
        if (homeMarker) map.removeLayer(homeMarker);
        homeMarker = L.marker([currentUser.home_address.lat, currentUser.home_address.lon], {
            icon: L.divIcon({ className: '', html: '<div style="font-size:24px">\uD83C\uDFE0</div>', iconSize: [24,24], iconAnchor: [12,24] })
        }).bindPopup('\uD83C\uDFE0 Casa').addTo(map);
    }
    filtrati.forEach(el => {
        const lat = el.center?.lat ?? el.lat, lon = el.center?.lon ?? el.lon;
        if (!lat || !lon) return;
        window._popupBivacchi[el.id] = el;
        const marker = L.marker([lat, lon], { icon: createBivaccoIcon(el) });
        marker.bindPopup(() => buildPopupHTML(el), {
            className: 'biv-popup-wrapper',
            maxWidth: 280,
            minWidth: 240,
            closeButton: false,
            autoPanPadding: [40, 60]
        });
        markers.push(marker);
    });
    markerClusterGroup.addLayers(markers);
    map.addLayer(markerClusterGroup);
    if (!mapInitialized && markers.length > 0) {
        const mapEl = document.getElementById('map');
        if (mapEl.offsetWidth > 0) { map.fitBounds(markerClusterGroup.getBounds().pad(0.1)); mapInitialized = true; }
        else mapFitPending = true;
    }
}

// ==================== DETAIL PANEL ====================
async function mostraDettagli(el) {
    selectedBivacco = el;
    const panel = document.getElementById('detail-panel');
    const container = document.getElementById('detail-data');

    // Clear immediately so old content never flashes
    container.innerHTML = '';

    const lat = el.center?.lat ?? el.lat, lon = el.center?.lon ?? el.lon;
    const quota = el.tags?.ele || 0;
    const isFav = isLocalFavorite(el.id) || (currentUser?.favorites?.includes(String(el.id)));
    const favBtn = document.getElementById('btn-detail-fav');
    const favIcon = document.getElementById('detail-fav-icon');
    if (isFav) { favBtn.classList.add('active'); favIcon.setAttribute('fill', 'var(--danger)'); }
    else { favBtn.classList.remove('active'); favIcon.setAttribute('fill', 'none'); }

    // Fetch fresh weather if stale
    if (Date.now() - (el.tags?.temperature_updated_at || 0) > WEATHER_STALE_MS) { await fetchTemperature(el); saveBivacchiToStorage(rawData); }

    const signal = estimateSignal(el);
    const note = getNote(el.id);

    let html = `<div class="detail-title">${escapeHtml(el.tags.name || 'Bivacco')}</div>
    <div class="detail-subtitle">
        <span>${el.tags.shelter_type || el.tags.tourism || 'Bivacco'}</span>
        ${el.tags?.capacity ? `<span>\u00B7 ${el.tags.capacity} posti</span>` : ''}
        ${lat ? `<span>\u00B7 ${lat.toFixed(4)}, ${lon.toFixed(4)}</span>` : ''}
    </div>`;

    // Main stats
    html += `<div class="detail-section"><div class="stat-grid">
        <div class="stat-box"><div class="stat-label">Altitudine</div><div class="stat-value accent">${quota}m</div></div>
        <div class="stat-box"><div class="stat-label">Temperatura</div><div class="stat-value blue">${el.tags?.temperature !== undefined ? el.tags.temperature+'\u00B0C' : '--'}</div></div>
        <div class="stat-box"><div class="stat-label">Min / Max</div><div class="stat-value">${el.tags?.temperature_min !== undefined ? el.tags.temperature_min : '--'}\u00B0 / ${el.tags?.temperature_max !== undefined ? el.tags.temperature_max : '--'}\u00B0</div></div>
        <div class="stat-box"><div class="stat-label">Neve</div><div class="stat-value">${el.tags?.snow === true ? '\u2744\uFE0F S\u00EC' : (el.tags?.snow === false ? 'No' : '--')}</div></div>
    </div></div>`;

    // Terrain
    html += `<div class="detail-section"><div class="detail-section-title">Terreno & Segnale</div><div class="stat-grid">
        <div class="stat-box"><div class="stat-label">Esposizione</div><div class="stat-value">${el.tags?.aspect_card || '--'}</div></div>
        <div class="stat-box"><div class="stat-label">Pendenza</div><div class="stat-value">${el.tags?.slope_deg !== undefined ? el.tags.slope_deg+'\u00B0' : '--'}</div></div>
        <div class="stat-box"><div class="stat-label">Segnale Cell.</div><div class="stat-value">${renderSignalBars(signal)}</div></div>
        <div class="stat-box"><div class="stat-label">Ore di Luce</div><div class="stat-value">${el.tags?.daylight_hours ? el.tags.daylight_hours+'h' : '--'}</div></div>
    </div></div>`;

    // Daylight
    if (el.tags?.sunrise && el.tags?.sunset) {
        html += `<div class="detail-section"><div class="detail-section-title">Alba & Tramonto</div>
            <div style="display:flex;justify-content:space-around;padding:8px 0">
                <div style="text-align:center"><div style="font-size:24px">\uD83C\uDF05</div><div style="font-weight:600">${el.tags.sunrise}</div><div class="text-muted" style="font-size:12px">Alba</div></div>
                <div style="text-align:center"><div style="font-size:24px">\uD83C\uDF07</div><div style="font-weight:600">${el.tags.sunset}</div><div class="text-muted" style="font-size:12px">Tramonto</div></div>
            </div></div>`;
    }

    // Additional info
    let extra = '';
    if (el.tags?.height) extra += `<p>\uD83D\uDCCF Altezza: ${el.tags.height}</p>`;
    if (el.tags?.description) extra += `<p>\uD83D\uDCDD ${escapeHtml(el.tags.description)}</p>`;
    if (el.tags?.mattress) extra += `<p>\uD83D\uDECF\uFE0F Materassi: ${el.tags.mattress === 'yes' ? 'S\u00EC' : el.tags.mattress}</p>`;
    if (el.tags?.fireplace) extra += `<p>\uD83D\uDD25 Camino: ${el.tags.fireplace === 'yes' ? 'S\u00EC' : el.tags.fireplace}</p>`;
    if (el.tags?.toilets) extra += `<p>\uD83D\uDEBD Bagno: ${el.tags.toilets === 'yes' ? 'S\u00EC' : el.tags.toilets}</p>`;
    if (el.tags?.drinking_water) extra += `<p>\uD83D\uDCA7 Acqua: ${el.tags.drinking_water === 'yes' ? 'S\u00EC' : el.tags.drinking_water}</p>`;
    if (extra) html += `<div class="detail-section"><div class="detail-section-title">Informazioni</div>${extra}</div>`;

    // Notes
    html += `<div class="detail-section"><div class="detail-section-title">Note Personali</div>
        <textarea class="notes-area" id="detail-notes" placeholder="Scrivi le tue note...">${escapeHtml(note)}</textarea>
        <button class="btn-ghost-full mt-2" onclick="saveNote('${el.id}', document.getElementById('detail-notes').value); this.textContent='Salvato \u2713'; setTimeout(()=>this.textContent='Salva Note',1500)">Salva Note</button>
    </div>`;

    // Navigation links
    html += `<div class="detail-section">
        ${lat ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" class="nav-btn">Portami qui</a>` : ''}
        <a href="https://www.openstreetmap.org/${el.type}/${el.id}" target="_blank" class="osm-btn">OpenStreetMap</a>
    </div>`;

    // Comments section
    html += '<div class="detail-section" id="comments-section"></div>';

    container.innerHTML = html;
    panel.classList.add('open');

    // Center map on selected bivacco
    if (currentView === 'map' && lat && lon) map.setView([lat, lon], Math.max(map.getZoom(), 13));

    // Load comments
    renderComments(el);
}

function closeDetailPanel() { document.getElementById('detail-panel').classList.remove('open'); selectedBivacco = null; }

// ==================== COMMENTS ====================
function formatDateTime(iso) { if (!iso) return ''; return new Date(iso).toLocaleString('it-IT', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }); }

async function renderComments(el) {
    const section = document.getElementById('comments-section');
    if (!section) return;
    section.innerHTML = '<div class="detail-section-title">Commenti</div><p class="small-text">Caricamento...</p>';
    let comments = [];
    try { const res = await fetch(`${API_BASE_URL}/api/bivacchi/${el.id}/comments`); if (res.ok) comments = await res.json(); } catch {}
    const commentsHtml = comments.length > 0 ? comments.map(c => `<div class="comment-item"><div class="comment-header"><strong>${escapeHtml(c.userName||'Utente')}</strong><span>${formatDateTime(c.created_at)}</span></div><p>${escapeHtml(c.text)}</p></div>`).join('') : '<p class="small-text">Nessun commento.</p>';
    const formHtml = currentUser ? `<div class="comment-form"><textarea id="comment-input" class="form-input" rows="2" placeholder="Scrivi un commento..."></textarea><button id="comment-submit" class="btn-accent-full" style="margin-top:8px">Invia</button></div>` : '<p class="small-text">Accedi per commentare.</p>';
    section.innerHTML = `<div class="detail-section-title">Commenti</div>${commentsHtml}${formHtml}`;
    if (currentUser) {
        const btn = document.getElementById('comment-submit'), inp = document.getElementById('comment-input');
        if (btn && inp) {
            btn.onclick = async () => {
                const text = inp.value.trim(); if (!text) return;
                if (!isOnline) { SyncManager.addToQueue({ type:'COMMENT', bivaccoId:el.id, text }); inp.value = ''; return; }
                btn.disabled = true; btn.textContent = 'Invio...';
                try { const r = await fetch(`${API_BASE_URL}/api/bivacchi/${el.id}/comments`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text}) }); if (r.ok) { inp.value = ''; renderComments(el); } }
                catch {} finally { btn.disabled = false; btn.textContent = 'Invia'; }
            };
        }
    }
}

// ==================== AUTH ====================
async function checkAuth() {
    try { const res = await fetch(API_BASE_URL+'/api/me'); if (res.ok) { const user = await res.json(); if (user) { currentUser = user; updateAuthUI(); } } } catch {}
}

function updateAuthUI() {
    const btn = document.getElementById('auth-btn');
    if (currentUser) {
        btn.title = currentUser.name;
        btn.classList.add('active');
        btn.onclick = openProfileModal;
    } else {
        btn.title = 'Accedi';
        btn.classList.remove('active');
        btn.onclick = openAuthModal;
    }
}

function openAuthModal() {
    document.getElementById('auth-modal').style.display = 'flex';
    document.getElementById('auth-error').innerHTML = '';
    // Clear form fields
    const fields = ['login-email','login-password','register-name','register-email','register-password'];
    fields.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    showLogin();
}
function closeAuthModal() { document.getElementById('auth-modal').style.display = 'none'; }
function openProfileModal() {
    document.getElementById('profile-name').innerText = currentUser.name;
    document.getElementById('profile-email').innerText = currentUser.email;
    document.getElementById('profile-date').innerText = new Date(currentUser.created_at).toLocaleDateString('it-IT', { year:'numeric', month:'long', day:'numeric' });
    document.getElementById('profile-address').innerText = currentUser.home_address?.address || 'Non impostato';
    loadFavorites();
    document.getElementById('profile-modal').style.display = 'flex';
}
function closeProfileModal() { document.getElementById('profile-modal').style.display = 'none'; }
function showRegister() { document.getElementById('auth-form').style.display = 'none'; document.getElementById('register-form').style.display = 'block'; }
function showLogin() { document.getElementById('auth-form').style.display = 'block'; document.getElementById('register-form').style.display = 'none'; }

async function handleLogin() {
    const email = document.getElementById('login-email').value, password = document.getElementById('login-password').value;
    if (!email || !password) { document.getElementById('auth-error').innerText = 'Compila tutti i campi'; return; }
    try { const res = await fetch(API_BASE_URL+'/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,password}) }); const data = await res.json(); if (res.ok) { currentUser = data.user; closeAuthModal(); updateAuthUI(); if (dataLoaded) aggiornaInterfaccia(); } else { document.getElementById('auth-error').innerText = data.error; } } catch { document.getElementById('auth-error').innerText = 'Errore login'; }
}

async function handleRegister() {
    const name = document.getElementById('register-name').value, email = document.getElementById('register-email').value, password = document.getElementById('register-password').value;
    if (!name || !email || !password) { document.getElementById('auth-error').innerText = 'Compila tutti i campi'; return; }
    try { const res = await fetch(API_BASE_URL+'/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name,email,password}) }); const data = await res.json(); if (res.ok) { currentUser = data.user; closeAuthModal(); updateAuthUI(); if (dataLoaded) aggiornaInterfaccia(); } else { document.getElementById('auth-error').innerText = data.error; } } catch { document.getElementById('auth-error').innerText = 'Errore registrazione'; }
}

async function handleLogout() {
    try {
        const res = await fetch(API_BASE_URL+'/api/logout', { method:'POST' });
        if (res.ok) {
            currentUser = null;
            // Remove home marker from map
            if (homeMarker) { map.removeLayer(homeMarker); homeMarker = null; }
            closeProfileModal();
            updateAuthUI();
            aggiornaInterfaccia();
        }
    } catch {}
}

async function toggleFavorite(bivaccoId) {
    toggleLocalFavorite(bivaccoId);
    if (currentUser) {
        if (isOnline) { try { const res = await fetch(`/api/favorites/${bivaccoId}`, { method:'POST' }); if (res.ok) currentUser.favorites = (await res.json()).favorites; } catch {} }
        else { SyncManager.addToQueue({ type:'FAVORITE', bivaccoId: String(bivaccoId) }); }
    }
    aggiornaInterfaccia();
    if (selectedBivacco && String(selectedBivacco.id) === String(bivaccoId)) mostraDettagli(selectedBivacco);
}

function loadFavorites() {
    const list = document.getElementById('favorites-list');
    const favIds = [...new Set([...localFavorites, ...(currentUser?.favorites || [])])];
    const favBivacchi = rawData.filter(el => favIds.includes(String(el.id)));
    if (favBivacchi.length === 0) { list.innerHTML = '<p>Nessun bivacco preferito</p>'; return; }
    list.innerHTML = favBivacchi.map(el => `<div class="favorite-item"><span>${escapeHtml(el.tags.name)} (${el.tags.ele||0}m)</span><button onclick="toggleFavorite('${el.id}')" style="background:none;border:none;cursor:pointer">\u2716</button></div>`).join('');
}

function openAddressModal() {
    document.getElementById('address-modal').style.display = 'flex';
    setTimeout(() => {
        if (!addressMap) {
            addressMap = L.map('address-map').setView([46.2, 11.5], 7);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '\u00A9 OSM' }).addTo(addressMap);
            addressMap.on('click', (e) => { selectedCoords = e.latlng; document.getElementById('coords-display').innerText = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`; });
        }
        addressMap.invalidateSize();
    }, 100);
}
function closeAddressModal() { document.getElementById('address-modal').style.display = 'none'; selectedCoords = null; }

async function handleSaveAddress() {
    const address = document.getElementById('address-input').value;
    if (!address || !selectedCoords) { document.getElementById('address-error').innerText = 'Compila indirizzo e seleziona coordinate'; return; }
    if (!isOnline) { currentUser.home_address = { address, lat: selectedCoords.lat, lon: selectedCoords.lng }; SyncManager.addToQueue({ type:'ADDRESS', payload:{ address, lat:selectedCoords.lat, lon:selectedCoords.lng } }); closeAddressModal(); openProfileModal(); aggiornaInterfaccia(); return; }
    try { const res = await fetch(API_BASE_URL+'/api/home-address', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ address, lat:selectedCoords.lat, lon:selectedCoords.lng }) }); if (res.ok) { currentUser.home_address = (await res.json()).home_address; closeAddressModal(); openProfileModal(); aggiornaInterfaccia(); } } catch { document.getElementById('address-error').innerText = 'Errore salvataggio'; }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) * 10) / 10;
}

// ==================== RADAR ====================
function initRadarControls() {
    if (typeof RadarService === 'undefined') return;
    const toggleRow = document.getElementById('btn-toggle-radar');
    const sw = document.getElementById('radar-switch');
    const panel = document.getElementById('radar-control-panel');
    const closeBtn = document.getElementById('radar-close-btn');
    const playBtn = document.getElementById('radar-play-btn');
    const opacitySlider = document.getElementById('radar-opacity');
    const colorScheme = document.getElementById('radar-color-scheme');

    function syncPlayBtn() {
        if (playBtn) playBtn.textContent = RadarService.isPlaying ? '⏸️' : '▶️';
    }

    toggleRow?.addEventListener('click', async () => {
        radarActive = !radarActive;
        sw.classList.toggle('active', radarActive);
        if (radarActive) {
            panel.style.display = 'block';
            if (!radarInitialized) {
                try {
                    await RadarService.init(map);
                    radarInitialized = true;
                    await RadarService.showRadar();
                } catch (err) {
                    console.error('[Radar] Init error:', err);
                    radarActive = false;
                    sw.classList.remove('active');
                    panel.style.display = 'none';
                    return;
                }
            } else {
                await RadarService.showRadar();
            }
            syncPlayBtn();
        } else {
            panel.style.display = 'none';
            // hideRadar keeps tiles cached; stop() would also clear them
            RadarService.hideRadar();
            syncPlayBtn();
        }
    });

    closeBtn?.addEventListener('click', () => {
        radarActive = false;
        sw.classList.remove('active');
        panel.style.display = 'none';
        RadarService.hideRadar();
        syncPlayBtn();
    });

    playBtn?.addEventListener('click', () => {
        if (RadarService.isPlaying) { RadarService.pause(); } else { RadarService.play(); }
        syncPlayBtn();
    });

    opacitySlider?.addEventListener('input', (e) => RadarService.setOpacity(parseInt(e.target.value) / 100));
    colorScheme?.addEventListener('change', (e) => RadarService.setColorScheme(parseInt(e.target.value)));
}

// ==================== GPX ====================
function setupGPXUploadListener() {
    const inp = document.getElementById('gpx-file-input');
    if (inp) inp.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file && typeof GPXService !== 'undefined' && map) {
            GPXService.handleFileUpload(file, map);
            // Show GPX proximity filter
            document.getElementById('gpx-proximity-section').style.display = '';
        }
        e.target.value = '';
    });
    // Init panel swipe/close/add events
    if (typeof GPXService !== 'undefined') {
        GPXService.initPanelEvents();
    }
}

// ==================== INIT ====================
function initMap() {
    map = L.map('map', { zoomControl: false, minZoom: 5, maxZoom: 18, tap: false }).setView([46.2, 11.5], 7);
    initMapLayers();
    osmLayer.addTo(map);
    // Update weather widget on map move
    map.on('moveend', debounce(updateWeatherWidget, 3000));
    initRadarControls();
    // Set map reference for GPXService
    if (typeof GPXService !== 'undefined') GPXService.mapRef = map;
}

async function initApp() {
    await checkAuth();
    updateAuthUI();
    initMap();
    setupSearch();
    setupGPXUploadListener();
    setupEventListeners();
    caricaDatiNordEst();
    // Initial weather widget
    setTimeout(updateWeatherWidget, 2000);
}

function setupEventListeners() {
    // View toggle
    document.getElementById('btn-toggle-view').addEventListener('click', () => { if (currentView === 'map') switchToListView(); else switchToMapView(); });

    // Filters
    document.getElementById('btn-open-filters').addEventListener('click', openFilters);
    document.getElementById('btn-close-filters').addEventListener('click', closeFilters);
    document.getElementById('sidebar-backdrop').addEventListener('click', closeFilters);

    // Filter inputs
    ['filter-alt-min','filter-alt-max','filter-temp-min','filter-temp-max','filter-dist-max','filter-gpx-proximity'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', debounce(() => { updateFilterDisplays(); aggiornaInterfaccia(); }, 200));
    });
    document.getElementById('sort-by').addEventListener('change', aggiornaInterfaccia);

    // Snow filter chips
    document.querySelectorAll('[data-snow]').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('[data-snow]').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            aggiornaInterfaccia();
        });
    });
    // Default: "all" selected
    document.getElementById('filter-snow-all')?.classList.add('active');

    // Aspect filter chips (multi-select, "Tutte" resets)
    document.querySelectorAll('#aspect-chips .filter-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            if (chip.dataset.aspect === 'all') {
                document.querySelectorAll('#aspect-chips .filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
            } else {
                document.querySelector('#aspect-chips [data-aspect="all"]')?.classList.remove('active');
                chip.classList.toggle('active');
                // If none selected, revert to "Tutte"
                if (!document.querySelector('#aspect-chips .filter-chip.active')) {
                    document.querySelector('#aspect-chips [data-aspect="all"]')?.classList.add('active');
                }
            }
            aggiornaInterfaccia();
        });
    });

    // GPX proximity toggle
    document.getElementById('gpx-prox-switch')?.addEventListener('click', function() { this.classList.toggle('active'); aggiornaInterfaccia(); });

    // Reset & Clear
    document.getElementById('btn-reset-filters')?.addEventListener('click', () => {
        document.getElementById('filter-alt-min').value = 0; document.getElementById('filter-alt-max').value = 4800;
        document.getElementById('filter-temp-min').value = -30; document.getElementById('filter-temp-max').value = 40;
        document.getElementById('filter-dist-max').value = 50;
        document.getElementById('sort-by').value = 'nome';
        document.getElementById('gpx-prox-switch')?.classList.remove('active');
        // Reset snow
        document.querySelectorAll('[data-snow]').forEach(c => c.classList.remove('active'));
        document.getElementById('filter-snow-all')?.classList.add('active');
        // Reset aspect
        document.querySelectorAll('#aspect-chips .filter-chip').forEach(c => c.classList.remove('active'));
        document.querySelector('#aspect-chips [data-aspect="all"]')?.classList.add('active');
        updateFilterDisplays(); aggiornaInterfaccia();
    });
    document.getElementById('btn-clear-db')?.addEventListener('click', async () => {
        if (!confirm('Svuotare il database locale?')) return;
        if (typeof DBService !== 'undefined') await DBService.clearAll();
        localStorage.removeItem('bivacchi-data');
        rawData = []; aggiornaInterfaccia();
    });

    // Detail panel
    document.getElementById('btn-detail-back').addEventListener('click', closeDetailPanel);
    document.getElementById('btn-detail-navigate').addEventListener('click', () => {
        if (selectedBivacco) {
            const lat = selectedBivacco.center?.lat ?? selectedBivacco.lat, lon = selectedBivacco.center?.lon ?? selectedBivacco.lon;
            if (lat && lon) window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`, '_blank');
        }
    });
    document.getElementById('btn-detail-fav').addEventListener('click', () => { if (selectedBivacco) toggleFavorite(selectedBivacco.id); });

    // Auth
    document.getElementById('auth-btn').addEventListener('click', () => { if (currentUser) openProfileModal(); else openAuthModal(); });

    // Map controls
    document.getElementById('btn-locate').addEventListener('click', locateUser);
    document.getElementById('btn-zoom-in').addEventListener('click', () => map.zoomIn());
    document.getElementById('btn-zoom-out').addEventListener('click', () => map.zoomOut());

    // Layers
    const layersBtn = document.getElementById('btn-layers');
    const layersMenu = document.getElementById('layers-menu');
    layersBtn.addEventListener('click', () => { const open = layersMenu.style.display !== 'none'; layersMenu.style.display = open ? 'none' : 'block'; layersBtn.classList.toggle('active', !open); });
    document.querySelectorAll('.layer-option').forEach(btn => btn.addEventListener('click', () => switchMapLayer(btn.dataset.layer)));

    // Trails
    const trailsBtn = document.getElementById('btn-trails');
    const trailsMenu = document.getElementById('trails-menu');
    trailsBtn.addEventListener('click', () => {
        // If tracks are loaded, toggle between opening panel and menu
        if (typeof GPXService !== 'undefined' && GPXService.tracks.length > 0) {
            const tp = document.getElementById('track-panel');
            if (tp?.classList.contains('tp-open')) {
                GPXService.closePanel();
            } else {
                GPXService.openPanel();
            }
        } else {
            const open = trailsMenu.style.display !== 'none';
            trailsMenu.style.display = open ? 'none' : 'block';
            trailsBtn.classList.toggle('active', !open);
        }
    });
    document.getElementById('btn-load-gpx-menu')?.addEventListener('click', () => { document.getElementById('gpx-file-input').click(); trailsMenu.style.display = 'none'; trailsBtn.classList.remove('active'); });

    // Weather widget
    document.getElementById('weather-widget').addEventListener('click', openWeatherPanel);
    document.getElementById('btn-close-weather').addEventListener('click', () => document.getElementById('weather-panel').style.display = 'none');

    // Track panel close
    document.getElementById('btn-close-track')?.addEventListener('click', () => {
        if (typeof GPXService !== 'undefined') GPXService.closePanel();
    });

    // Close flyout menus when clicking outside
    document.addEventListener('click', (e) => {
        if (!document.getElementById('layers-ctrl-group').contains(e.target)) { layersMenu.style.display = 'none'; layersBtn.classList.remove('active'); }
        if (!document.getElementById('trails-ctrl-group').contains(e.target)) { trailsMenu.style.display = 'none'; trailsBtn.classList.remove('active'); }
    });

    // ── Android back button / PWA history navigation ──
    setupBackNavigation();
}

// ==================== PWA BACK NAVIGATION ====================
function setupBackNavigation() {
    // Push initial state
    if (!history.state) history.replaceState({ view: 'main' }, '');

    window.addEventListener('popstate', (e) => {
        const state = e.state;
        // Try closing overlays in priority order
        // 1. Auth / Profile modals
        const authModal = document.getElementById('auth-modal');
        const profileModal = document.getElementById('profile-modal');
        if (authModal?.style.display !== 'none' && authModal?.style.display) {
            authModal.style.display = 'none';
            pushNavState('main');
            return;
        }
        if (profileModal?.style.display !== 'none' && profileModal?.style.display) {
            profileModal.style.display = 'none';
            pushNavState('main');
            return;
        }

        // 2. Weather panel
        const weatherPanel = document.getElementById('weather-panel');
        if (weatherPanel?.style.display !== 'none' && weatherPanel?.style.display) {
            weatherPanel.style.display = 'none';
            pushNavState('main');
            return;
        }

        // 3. Detail panel
        const detailPanel = document.getElementById('detail-panel');
        if (detailPanel?.classList.contains('open')) {
            closeDetailPanel();
            pushNavState('main');
            return;
        }

        // 4. Filter sidebar
        const sidebar = document.getElementById('sidebar-filters');
        if (sidebar?.classList.contains('open')) {
            closeFilters();
            pushNavState('main');
            return;
        }

        // 5. Track panel
        const trackPanel = document.getElementById('track-panel');
        if (trackPanel?.classList.contains('tp-open')) {
            if (typeof GPXService !== 'undefined') GPXService.closePanel();
            pushNavState('main');
            return;
        }

        // 6. Flyout menus
        const layersMenu = document.getElementById('layers-menu');
        const trailsMenu = document.getElementById('trails-menu');
        if (layersMenu?.style.display !== 'none' && layersMenu?.style.display) {
            layersMenu.style.display = 'none';
            document.getElementById('btn-layers')?.classList.remove('active');
            pushNavState('main');
            return;
        }
        if (trailsMenu?.style.display !== 'none' && trailsMenu?.style.display) {
            trailsMenu.style.display = 'none';
            document.getElementById('btn-trails')?.classList.remove('active');
            pushNavState('main');
            return;
        }

        // 7. List view → go back to map
        if (currentView === 'list') {
            switchToMapView();
            pushNavState('main');
            return;
        }

        // If nothing to close, push state back to prevent app exit
        pushNavState('main');
    });
}

function pushNavState(view) {
    history.pushState({ view }, '');
}

// Patch functions that open panels to push history state
const _origMostraDettagli = mostraDettagli;
mostraDettagli = async function(el) {
    pushNavState('detail');
    return _origMostraDettagli(el);
};

const _origOpenFilters = openFilters;
openFilters = function() {
    pushNavState('filters');
    return _origOpenFilters();
};

const _origSwitchToListView = switchToListView;
switchToListView = function() {
    pushNavState('list');
    return _origSwitchToListView();
};

initApp();
