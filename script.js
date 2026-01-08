function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

// URL base dell'API - usa percorsi relativi
// Questo funziona automaticamente sia in locale che tramite reverse proxy Caddy
// - localhost:3000 → /api/... → localhost:3000/api/...
// - dominio.com (Caddy) → /api/... → Caddy intercetta e proxya a port 3000
const API_BASE_URL = '';
// Soglie per stima neve più affidabile
const SNOW_DEPTH_THRESHOLD_CM = 1; // neve al suolo considerata presente da >=1cm
const SNOWFALL_RECENT_THRESHOLD_MM = 5; // nevicate recenti somma >=5mm
const SNOW_RECENT_HOURS = 48; // finestra recente per nevicate/temperature
const TEMP_FREEZE_THRESHOLD_C = 0; // congelamento
const TEMP_NEAR_FREEZE_C = 2; // vicino a zero
const ALTITUDE_SNOW_SUPPORT_M = 1700; // quota oltre la quale la neve è probabile
const WEATHER_STALE_MS = 60 * 60 * 1000; // 1h: staleness per temperatura/neve
const DAYLIGHT_STALE_MS = 24 * 60 * 60 * 1000; // 24h: staleness per ore di luce
const SLOPE_SAMPLE_OFFSET_DEG = 0.001; // offset per campionamento pendenza/esposizione
// Rate limiting per API elevazioni
const ELEVATION_API_DELAY_MS = 500; // delay minimo tra richieste
const ELEVATION_CACHE_MS = 7 * 24 * 60 * 60 * 1000; // cache per 7 giorni
let elevationCache = {};
let lastElevationFetchTime = 0;
let elevationBackoffMs = 500;

// SPA simplified: calcolo base posizione sole
function solarPosition(lat, lon, date = new Date()) {
    const deg2rad = Math.PI / 180;
    const J2000 = 2451545.0;
    const JD = date.getTime() / 86400000 + 2440587.5;
    const T = (JD - J2000) / 36525;
    const L0 = (280.46646 + 36000.76983 * T + 0.0003032 * T * T) % 360;
    const M = (357.52911 + 35999.05029 * T - 0.0001536 * T * T) % 360;
    const e = 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M * deg2rad) +
              (0.019993 - 0.000101 * T) * Math.sin(2 * M * deg2rad) +
              0.000289 * Math.sin(3 * M * deg2rad);
    const lambda = (L0 + C) % 360;
    const nu = (M + C) % 360;
    const Omega = (125.04 - 1934.136 * T) % 360;
    const epsilon = 23.4393 - 0.0130 * T + (0.00000016 * T - 0.000000504) * T;
    const alpha_deg = Math.atan2(Math.cos(epsilon * deg2rad) * Math.sin(lambda * deg2rad), Math.cos(lambda * deg2rad)) / deg2rad;
    const delta = Math.asin(Math.sin(epsilon * deg2rad) * Math.sin(lambda * deg2rad)) / deg2rad;
    const H0 = Math.acos(-Math.tan(lat * deg2rad) * Math.tan(delta * deg2rad)) / deg2rad;
    return { declination: delta, H0, lambda, epsilon };
}

function calculateDaylight(lat, lon, elev_m = 0, slope_deg = 0, aspect_deg = 0, date = new Date()) {
    try {
        const sp = solarPosition(lat, lon, date);
        let H0 = sp.H0; // half-day length in degrees
        
        // Adjust for horizon dip and terrain
        // Dip angle ~ sqrt(2h/R) (in radians) where h in meters, R Earth radius
        const elev = Math.max(0, elev_m);
        const horizonDip = Math.sqrt((2 * elev) / 6371000) * (180 / Math.PI);
        H0 -= horizonDip;
        if (slope_deg > 10 && Math.abs((aspect_deg + 180) % 360 - 180) < 90) {
            H0 -= slope_deg * 0.1;
        }
        H0 = Math.min(90, Math.max(0, H0));
        
        const daylight_hours = Math.max(0, (2 * H0) / 15);
        
        // Solar noon UTC: adjust for longitude relative to standard meridian (15°E for Italy UTC+1)
        const stdMeridian = 15;
        const lonOffset = 4 * (lon - stdMeridian) / 60; // convert to hours
        const solarNoonUTC = 12 + lonOffset;
        
        // Sunrise/sunset UTC (H0/15 is hours from solar noon)
        const sunrise_utc = solarNoonUTC - H0 / 15;
        const sunset_utc = solarNoonUTC + H0 / 15;
        
        // Timezone offset (negative for east)
        const tzOffset = -date.getTimezoneOffset() / 60;
        
        // Convert to local times
        const sunrise_local = sunrise_utc + tzOffset;
        const sunset_local = sunset_utc + tzOffset;
        
        // Format times with proper wrapping
        const formatTime = (hours) => {
            let totalMinutes = Math.round(hours * 60);
            totalMinutes %= (24 * 60);
            if (totalMinutes < 0) totalMinutes += 24 * 60;
            const h = Math.floor(totalMinutes / 60);
            const m = totalMinutes % 60;
            return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        };
        
        return {
            sunrise: formatTime(sunrise_local),
            sunset: formatTime(sunset_local),
            daylight_hours: Math.round(daylight_hours * 100) / 100,
            date_computed: date.toISOString().split('T')[0]
        };
    } catch (e) {
        console.error('Errore calcolo luce solare:', e);
        return null;
    }
}

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Verifica se i dati di alba/tramonto salvati sono plausibili
function isDaylightInvalid(tags = {}) {
    const { sunrise, sunset, daylight_hours } = tags;
    if (!sunrise || !sunset || daylight_hours === undefined || daylight_hours === null) return true;
    const re = /^\d{2}:\d{2}$/;
    if (!re.test(sunrise) || !re.test(sunset)) return true;
    const dh = Number(daylight_hours);
    if (!Number.isFinite(dh) || dh <= 0 || dh > 24) return true;
    if (sunrise === sunset) return true;
    return false;
}

async function fetchDaylightForEl(el) {
    const lat = el.center?.lat ?? el.lat;
    const lon = el.center?.lon ?? el.lon;
    const elev = parseInt(el.tags?.ele ?? 0, 10) || 0;
    const slope = el.tags?.slope_deg ?? 0;
    const aspect = el.tags?.aspect_deg ?? 0;
    try {
        const daylight = calculateDaylight(lat, lon, elev, slope, aspect, new Date());
        if (daylight) {
            el.tags = el.tags || {};
            el.tags.sunrise = daylight.sunrise;
            el.tags.sunset = daylight.sunset;
            el.tags.daylight_hours = daylight.daylight_hours;
            el.tags.daylight_updated_at = Date.now();
            return true;
        }
    } catch (e) {
        console.error(`Errore luce per ${lat},${lon}:`, e);
    }
    return false;
}

async function fetchDaylightInBackground(data) {
    const now = Date.now();
    let updateCount = 0;
    for (const el of data) {
        const lastDaylight = el.tags?.daylight_updated_at || 0;
        const invalid = isDaylightInvalid(el.tags);
        if (!invalid && now - lastDaylight < DAYLIGHT_STALE_MS) continue;
        const ok = await fetchDaylightForEl(el);
        if (ok) {
            updateCount++;
            try { localStorage.setItem('bivacchi-data', JSON.stringify(rawData)); } catch {}
        }
    }
    // Single POST after all daylight calculations are complete
    if (updateCount > 0) {
        fetch(API_BASE_URL + '/api/bivacchi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawData)
        }).catch(() => {});
    }
}

function metersPerDegree(lat) {
    const latRad = (lat * Math.PI) / 180;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(latRad);
    return { mPerDegLat, mPerDegLon };
}

function degToCardinal(deg) {
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    const ix = Math.round(((deg % 360) / 45)) % 8;
    return dirs[ix];
}

async function getElevationSingle(lat, lon) {
    const key = `${Math.round(lat * 1000)},${Math.round(lon * 1000)}`;
    const cached = elevationCache[key];
    if (cached && Date.now() - cached.ts < ELEVATION_CACHE_MS) {
        return cached.val;
    }
    // Rate limiting: attendi il minimo delay, poi applica backoff se necessario
    const elapsed = Date.now() - lastElevationFetchTime;
    if (elapsed < elevationBackoffMs) {
        await new Promise(r => setTimeout(r, elevationBackoffMs - elapsed));
    }
    lastElevationFetchTime = Date.now();
    try {
        const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
        if (r.status === 429) {
            // Rate limit hit, aumenta backoff esponenzialmente
            elevationBackoffMs = Math.min(elevationBackoffMs * 2, 5000);
            return null;
        }
        if (!r.ok) return null;
        const d = await r.json();
        if (d.elevation && d.elevation.length > 0 && !isNaN(d.elevation[0])) {
            const val = Number(d.elevation[0]);
            elevationCache[key] = { val, ts: Date.now() };
            elevationBackoffMs = 500; // reset backoff
            return val;
        }
    } catch (e) {
        console.error(`Errore elevazione ${lat},${lon}:`, e.message);
    }
    // Open-elevation ha problemi CORS frequenti, skip per evitare spam
    return null;
}

async function computeSlopeAspect(lat, lon) {
    const { mPerDegLat, mPerDegLon } = metersPerDegree(lat);
    const dLat = SLOPE_SAMPLE_OFFSET_DEG;
    const dLon = SLOPE_SAMPLE_OFFSET_DEG;
    const [zN, zS, zE, zW] = await Promise.all([
        getElevationSingle(lat + dLat, lon),
        getElevationSingle(lat - dLat, lon),
        getElevationSingle(lat, lon + dLon),
        getElevationSingle(lat, lon - dLon)
    ]);
    if ([zN, zS, zE, zW].some(z => z === null)) return null;
    const dy = 2 * dLat * mPerDegLat;
    const dx = 2 * dLon * mPerDegLon;
    const dzdy = (zN - zS) / dy;
    const dzdx = (zE - zW) / dx;
    const slopeRad = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy));
    const slopeDeg = Math.round((slopeRad * 180) / Math.PI);
    let aspectRad = Math.atan2(dzdy, -dzdx);
    let aspectDeg = (aspectRad * 180) / Math.PI;
    if (aspectDeg < 0) aspectDeg += 360;
    aspectDeg = Math.round(aspectDeg);
    return { slopeDeg, aspectDeg, aspectCard: degToCardinal(aspectDeg) };
}

async function calculateAspectForEl(el) {
    const lat = el.center?.lat ?? el.lat;
    const lon = el.center?.lon ?? el.lon;
    if (!lat || !lon) return false;
    const r = await computeSlopeAspect(lat, lon);
    if (!r) return false;
    el.tags = el.tags || {};
    el.tags.slope_deg = r.slopeDeg;
    el.tags.aspect_deg = r.aspectDeg;
    el.tags.aspect_card = r.aspectCard;
    el.tags.aspect_updated_at = Date.now();
    return true;
}

async function computeAspectInBackground(data) {
    // Filtra solo bivacchi senza esposizione/pendenza già calcolate
    const toCompute = data.filter(el => !el.tags || (el.tags.aspect_deg === undefined && el.tags.aspect_card === undefined));
    if (toCompute.length === 0) return;
    console.log(`Inizio calcolo esposizione/pendenza: ${toCompute.length} bivacchi da calcolare una sola volta.`);
    let successCount = 0;
    for (const el of toCompute) {
        const ok = await calculateAspectForEl(el);
        if (ok) {
            successCount++;
            // Save to localStorage only
            try { localStorage.setItem('bivacchi-data', JSON.stringify(rawData)); } catch {}
        } else {
            // Fallito (rate limit, rete, ecc), stop gracefully: riproverà al prossimo caricamento
            console.warn(`Calcolo esposizione interrotto dopo ${successCount} successi, riproverà al prossimo caricamento.`);
            break;
        }
        // Delay gestito dal rate limiter
        await new Promise(r => setTimeout(r, Math.max(500, elevationBackoffMs)));
    }
    // Single POST after all calculations complete
    if (successCount > 0) {
        try { localStorage.setItem('bivacchi-data', JSON.stringify(rawData)); } catch {}
        fetch(API_BASE_URL + '/api/bivacchi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawData)
        }).catch(() => {});
    }
    console.log(`Calcolo esposizione completato: ${successCount}/${toCompute.length} bivacchi calcolati e salvati.`);
}

let rawData = [];
const listContainer = document.getElementById('bivacchi-list');
let map;
let markers = [];
let currentUser = null;
let addressMap = null;
let selectedCoords = null;
let dataLoaded = false; // Flag per tracciare se i dati sono caricati
let mapInitialized = false; // Flag per il primo caricamento della mappa
let mapFitPending = false; // Fit in sospeso quando la mappa era nascosta
let homeMarker = null; // Marker dell'indirizzo di casa
let altSlider = null; // noUiSlider per altitudine
let tempSlider = null; // noUiSlider per temperatura

function isMapVisible() {
    const el = document.getElementById('map');
    if (!el) return false;
    const style = window.getComputedStyle(el);
    const visible = style.display !== 'none' && el.offsetWidth > 0 && el.offsetHeight > 0;
    return visible;
}

// Funzione per calcolare altitudini con retry
async function calculateElevationsWithRetry(toCalculate, retries = 5) {
    for (const el of toCalculate) {
        const lat = el.center?.lat ?? el.lat;
        const lon = el.center?.lon ?? el.lon;
        let success = false;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const resAlt = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
                const dataAlt = await resAlt.json();
                if (dataAlt.elevation && dataAlt.elevation.length > 0 && !isNaN(dataAlt.elevation[0])) {
                    el.tags.ele = Math.round(dataAlt.elevation[0]);
                    success = true;
                    break;
                }
            } catch(e) {
                console.error(`Tentativo ${attempt} per ${lat},${lon}:`, e);
            }
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 2000)); // Delay più lungo tra tentativi
            }
        }
        if (!success) {
            // Fallback a open-elevation
            try {
                const resAlt = await fetch(`https://open-elevation.com/api/v1/lookup?locations=${lat},${lon}`);
                const dataAlt = await resAlt.json();
                if (dataAlt.results && dataAlt.results[0] && dataAlt.results[0].elevation !== undefined) {
                    el.tags.ele = Math.round(dataAlt.results[0].elevation);
                    success = true;
                }
            } catch(e) {
                console.error(`Fallback fallito per ${lat},${lon}`);
            }
        }
        if (!success) {
            el.tags.ele = 0; // Ultimo fallback
        }
        
        // Delay tra richieste
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// Funzione per ottenere temperatura per un singolo bivacco
async function fetchTemperature(el) {
    const lat = el.center?.lat ?? el.lat;
    const lon = el.center?.lon ?? el.lon;
    if (!lat || !lon) return false;
    
    try {
        // Usa dati orari + daily min/max per stima più robusta: temperatura, snowfall, snow_depth
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,snowfall,snow_depth&daily=temperature_2m_max,temperature_2m_min&past_days=2&forecast_days=1&timezone=auto`;
        const resMeteo = await fetch(url);
        const dataMeteo = await resMeteo.json();
        const hourly = dataMeteo.hourly || {};
        const temps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
        const snowfall = Array.isArray(hourly.snowfall) ? hourly.snowfall : [];
        const snowDepth = Array.isArray(hourly.snow_depth) ? hourly.snow_depth : [];
        const daily = dataMeteo.daily || {};

        // Temperatura: usa l'ultimo valore disponibile
        if (temps.length > 0) {
            const lastTemp = temps[temps.length - 1];
            if (lastTemp !== null && lastTemp !== undefined && !isNaN(lastTemp)) {
                el.tags.temperature = Math.round(lastTemp);
                el.tags.temperature_updated_at = Date.now();
            }
        }

        // Min/Max giornalieri: usa il giorno corrente (timezone auto) per evitare mismatch
        const dayList = Array.isArray(daily.time) ? daily.time : [];
        let idxToday = -1;
        if (dayList.length > 0) {
            const todayStr = new Date().toISOString().split('T')[0];
            idxToday = dayList.findIndex(t => t === todayStr);
        }
        const pickIdx = (arr) => {
            if (!Array.isArray(arr) || arr.length === 0) return null;
            if (idxToday >= 0 && idxToday < arr.length) return arr[idxToday];
            return arr[arr.length - 1];
        };

        const vMin = pickIdx(daily.temperature_2m_min);
        const vMax = pickIdx(daily.temperature_2m_max);
        if (vMin !== null && vMin !== undefined && !isNaN(vMin)) {
            el.tags.temperature_min = Math.round(vMin);
        }
        if (vMax !== null && vMax !== undefined && !isNaN(vMax)) {
            el.tags.temperature_max = Math.round(vMax);
        }

        // Calcola nevicate recenti e neve al suolo
        let recentSnowfallSum = 0;
        if (snowfall.length > 0) {
            const n = snowfall.length;
            const start = Math.max(0, n - SNOW_RECENT_HOURS);
            for (let i = start; i < n; i++) {
                const v = snowfall[i];
                if (v !== null && v !== undefined && !isNaN(v)) {
                    recentSnowfallSum += v; // mm
                }
            }
        }

        // Ultimo snow depth disponibile
        let lastSnowDepth = null;
        if (snowDepth.length > 0) {
            const v = snowDepth[snowDepth.length - 1];
            if (v !== null && v !== undefined && !isNaN(v)) {
                lastSnowDepth = Math.round(v); // cm
            }
        }

        // Temperatura minima recente (per supportare la stima)
        let recentMinTemp = null;
        if (temps.length > 0) {
            const n = temps.length;
            const start = Math.max(0, n - SNOW_RECENT_HOURS);
            for (let i = start; i < n; i++) {
                const v = temps[i];
                if (v !== null && v !== undefined && !isNaN(v)) {
                    recentMinTemp = recentMinTemp === null ? v : Math.min(recentMinTemp, v);
                }
            }
            if (recentMinTemp !== null) recentMinTemp = Math.round(recentMinTemp);
        }

        // Heuristic combinata: neve al suolo, nevicate recenti + temperature, quota
        const ele = parseInt(el.tags?.ele ?? 0, 10) || 0;
        let snowDetected = false;
        let confidence = 'basso';
        if (lastSnowDepth !== null && lastSnowDepth >= SNOW_DEPTH_THRESHOLD_CM) {
            snowDetected = true;
            confidence = 'alto';
        } else if (recentSnowfallSum >= SNOWFALL_RECENT_THRESHOLD_MM && recentMinTemp !== null && recentMinTemp <= TEMP_FREEZE_THRESHOLD_C) {
            snowDetected = true;
            confidence = 'medio';
        } else if (ele >= ALTITUDE_SNOW_SUPPORT_M && recentMinTemp !== null && recentMinTemp <= TEMP_NEAR_FREEZE_C) {
            snowDetected = true;
            confidence = 'basso';
        }

        el.tags.snow = snowDetected;
        el.tags.snow_confidence = confidence;
        if (lastSnowDepth !== null) el.tags.snow_depth_cm = lastSnowDepth;
        el.tags.snowfall_48h_mm = Math.round(recentSnowfallSum);
        if (recentMinTemp !== null) el.tags.temp_min_48h = recentMinTemp;
        el.tags.snow_updated_at = Date.now();
        return true;
    } catch(e) {
        console.error(`Errore temperatura per ${lat},${lon}:`, e);
    }
    return false;
}

// Funzione per ottenere temperature per i bivacchi (in background, non blocca)
async function fetchTemperaturesInBackground(data) {
    const now = Date.now();
    let updateCount = 0;
    for (const el of data) {
        const lastTemp = el.tags?.temperature_updated_at || 0;
        const lastSnow = el.tags?.snow_updated_at || 0;
        const lastUpdate = Math.max(lastTemp, lastSnow);
        // Salta se non è stale
        if (now - lastUpdate < WEATHER_STALE_MS) {
            continue;
        }
        // Aggiorna meteo in modo asincrono
        await fetchTemperature(el);
        updateCount++;
        // Persisti cache locale e aggiorna UI
        try {
            localStorage.setItem('bivacchi-data', JSON.stringify(rawData));
        } catch {}
        aggiornaInterfaccia();
        // Delay tra richieste per non sovraccaricare l'API
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Single POST after all temperature updates complete
    if (updateCount > 0) {
        fetch(API_BASE_URL + '/api/bivacchi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawData)
        }).catch(() => {});
    }
}

// Funzione per ottenere temperature per i bivacchi (blocca fino a completamento)
async function fetchTemperaturesForAll(data) {
    for (const el of data) {
        await fetchTemperature(el);
        // Delay tra richieste per non sovraccaricare l'API
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// Funzione per caricare i dati dei bivacchi nel Nord-Est Italia
async function caricaDatiNordEst() {
    // 1. Prova a caricare da localStorage e mostra subito
    const cachedData = localStorage.getItem('bivacchi-data');
    if (cachedData) {
        try {
            rawData = JSON.parse(cachedData);
            dataLoaded = true;
            await new Promise(resolve => setTimeout(resolve, 0));
            aggiornaInterfaccia();
            // Aggiorna temperature in background
            fetchTemperaturesInBackground(rawData).then(() => {
                localStorage.setItem('bivacchi-data', JSON.stringify(rawData));
            });
            // Calcola esposizione/pendenza in background
            computeAspectInBackground(rawData);
            // Calcola ore di luce in background
            fetchDaylightInBackground(rawData);
        } catch (e) {
            console.error("Errore lettura localStorage:", e);
        }
    }

    // 2. Carica sempre dal server e mostra appena disponibili
    try {
        const res = await fetch(API_BASE_URL + '/api/bivacchi');
        if (res.ok) {
            const data = await res.json();
            if (data.length > 0) {
                rawData = data;
                localStorage.setItem('bivacchi-data', JSON.stringify(rawData));
                dataLoaded = true;
                aggiornaInterfaccia();
                // Aggiorna temperature in background
                fetchTemperaturesInBackground(rawData).then(() => {
                    localStorage.setItem('bivacchi-data', JSON.stringify(rawData));
                });
                // Calcola esposizione/pendenza in background
                computeAspectInBackground(rawData);
                // Calcola ore di luce in background
                fetchDaylightInBackground(rawData);
                return;
            }
        }
    } catch (e) {
        console.error("Errore caricamento da server:", e);
    }

    // 3. Se non ci sono dati sul server, carica da API Overpass
    listContainer.innerHTML = '<p class="placeholder-text">Caricamento bivacchi dal Nord-Est Italia...</p>';

    // Query Overpass per i bivacchi in Veneto, Trentino e Friuli
    const query = `
        [out:json][timeout:180];
        (
          area[name="Veneto"][admin_level="4"];
          area[name="Trentino-Alto Adige"][admin_level="4"];
          area[name="Friuli-Venezia Giulia"][admin_level="4"];
        )->.regioni;
        (
          node["tourism"~"alpine_hut|wilderness_hut"]["name"~"bivacco",i](area.regioni);
          way["tourism"~"alpine_hut|wilderness_hut"]["name"~"bivacco",i](area.regioni);
          node["amenity"="shelter"]["name"~"bivacco",i](area.regioni);
          way["amenity"="shelter"]["name"~"bivacco",i](area.regioni);
          node["shelter_type"~"bivouac|basic_hut"](area.regioni);
          way["shelter_type"~"bivouac|basic_hut"](area.regioni);
        );
        out center;
    `;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    try {
        const res = await fetch(url);
        if (!res.ok) {
            let errorMsg = `Errore HTTP: ${res.status}`;
            if (res.status === 429) {
                errorMsg = "Troppe richieste al server. Riprova più tardi.";
            } else if (res.status === 504) {
                errorMsg = "Il server è sovraccarico. Riprova più tardi.";
            }
            throw new Error(errorMsg);
        }
        const data = await res.json();
        rawData = data.elements.filter(el => el.tags?.name && el.tags.name.trim() !== '');

        // Calcola altitudini mancanti con retry
        const toCalculate = rawData.filter(el => !el.tags.ele && (el.center?.lat || el.lat) && (el.center?.lon || el.lon));
        if (toCalculate.length > 0) {
            listContainer.innerHTML = '<p class="placeholder-text">Calcolo altitudini...</p>';
            await calculateElevationsWithRetry(toCalculate);
        }

        // Mostra i dati immediatamente senza aspettare le temperature
        dataLoaded = true;
        aggiornaInterfaccia();

        // Salva sul server i dati di base
        await fetch(API_BASE_URL + '/api/bivacchi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawData)
        });

        // Ottieni temperature in background per non bloccare l'UI
        listContainer.innerHTML = '<div><p class="placeholder-text">Caricamento temperature...</p></div>';
        fetchTemperaturesForAll(rawData).then(() => {
            // Salva i dati con le temperature
            fetch(API_BASE_URL + '/api/bivacchi', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(rawData)
            }).catch(e => console.error("Errore salvataggio dati:", e));
            // Aggiorna l'UI finale
            aggiornaInterfaccia();
            // Calcola esposizione/pendenza in background
            computeAspectInBackground(rawData);
            // Calcola ore di luce in background
            fetchDaylightInBackground(rawData);
        });
    } catch (e) {
        console.error("Errore Overpass API:", e);
        listContainer.innerHTML = `<p class="placeholder-text error">${e.message}</p><button id="retry-btn" onclick="caricaDatiVeneto()">Riprova</button>`;
    }
}

// Funzione per aggiornare la lista
function aggiornaInterfaccia() {
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    let minAlt = 0, maxAlt = 4000;
    if (altSlider) {
        const [aMin, aMax] = altSlider.get().map(v => Math.round(parseFloat(v)));
        minAlt = aMin; maxAlt = aMax;
    }
    let minTemp = -20, maxTemp = 40;
    if (tempSlider) {
        const [tMin, tMax] = tempSlider.get().map(v => Math.round(parseFloat(v)));
        minTemp = tMin; maxTemp = tMax;
    }
    
    // Get filter values (desktop or mobile)
    let maxDist = 50;
    let sortBy = 'nome';
    
    // Check which view is active and use appropriate inputs
    if (window.innerWidth <= 1024) {
        // Mobile: prioritize mobile inputs
        const distInputM = document.getElementById('filter-dist-max-mobile');
        const sortInputM = document.getElementById('sort-by-mobile');
        if (distInputM) maxDist = parseInt(distInputM.value, 10);
        if (sortInputM) sortBy = sortInputM.value;
    } else {
        // Desktop: use desktop inputs
        const distInput = document.getElementById('filter-dist-max');
        const sortInput = document.getElementById('sort-by');
        if (distInput) maxDist = parseInt(distInput.value, 10);
        if (sortInput) sortBy = sortInput.value;
    }
    
    // Update desktop displays
    const altMinSpan = document.getElementById('alt-min-val');
    const altMaxSpan = document.getElementById('alt-max-val');
    const tempMinSpan = document.getElementById('temp-min-val');
    const tempMaxSpan = document.getElementById('temp-max-val');
    const distSpan = document.getElementById('dist-max-val');
    
    if (altMinSpan) altMinSpan.innerText = minAlt;
    if (altMaxSpan) altMaxSpan.innerText = maxAlt;
    if (tempMinSpan) tempMinSpan.innerText = minTemp;
    if (tempMaxSpan) tempMaxSpan.innerText = maxTemp;
    if (distSpan) distSpan.innerText = maxDist;
    
    // Update mobile displays
    const altMinSpanM = document.getElementById('alt-min-val-mobile');
    const altMaxSpanM = document.getElementById('alt-max-val-mobile');
    const tempMinSpanM = document.getElementById('temp-min-val-mobile');
    const tempMaxSpanM = document.getElementById('temp-max-val-mobile');
    const distSpanM = document.getElementById('dist-max-val-mobile');
    
    if (altMinSpanM) altMinSpanM.innerText = minAlt;
    if (altMaxSpanM) altMaxSpanM.innerText = maxAlt;
    if (tempMinSpanM) tempMinSpanM.innerText = minTemp;
    if (tempMaxSpanM) tempMaxSpanM.innerText = maxTemp;
    if (distSpanM) distSpanM.innerText = maxDist;

    // Mostra filtro distanza solo se utente loggato con indirizzo impostato
    const distanceFilterGroup = document.getElementById('distance-filter-group');
    const distanceFilterGroupMobile = document.getElementById('distance-filter-group-mobile');
    const distanceSortOptions = document.querySelectorAll('.distance-sort-option');
    const distanceSortOptionsMobile = document.querySelectorAll('.distance-sort-option-mobile');
    
    if (currentUser && currentUser.home_address) {
        if (distanceFilterGroup) distanceFilterGroup.style.display = 'block';
        if (distanceFilterGroupMobile) distanceFilterGroupMobile.style.display = 'block';
        distanceSortOptions.forEach(opt => opt.style.display = '');
        distanceSortOptionsMobile.forEach(opt => opt.style.display = '');
    } else {
        if (distanceFilterGroup) distanceFilterGroup.style.display = 'none';
        if (distanceFilterGroupMobile) distanceFilterGroupMobile.style.display = 'none';
        distanceSortOptions.forEach(opt => opt.style.display = 'none');
        distanceSortOptionsMobile.forEach(opt => opt.style.display = 'none');
    }

    listContainer.innerHTML = '';

    const uniqueIds = new Set();
    
    const filtrati = rawData.filter(el => {
        if (uniqueIds.has(el.id)) {
            return false;
        }

        const nome = (el.tags?.name || "").toLowerCase();
        const alt = el.tags?.ele !== undefined && !isNaN(parseInt(el.tags.ele, 10)) ? parseInt(el.tags.ele, 10) : 0;
        
        const matchNome = nome.includes(searchTerm);
        const matchAlt = (alt >= minAlt && alt <= maxAlt);
        
        // Filtro temperatura (usa il valore se presente, altrimenti N/A non filtra)
        let matchTemp = true;
        if (el.tags?.temperature !== undefined) {
            const temp = parseInt(el.tags.temperature, 10);
            matchTemp = (temp >= minTemp && temp <= maxTemp);
        }
        
        // Filtro distanza da casa
        let matchDist = true;
        if (currentUser && currentUser.home_address) {
            const dist = calculateDistance(
                currentUser.home_address.lat,
                currentUser.home_address.lon,
                el.center?.lat ?? el.lat,
                el.center?.lon ?? el.lon
            );
            matchDist = dist <= maxDist;
        }
        
        if (matchNome && matchAlt && matchTemp && matchDist) {
            uniqueIds.add(el.id);
            return true;
        }
        return false;
    });

    if (filtrati.length === 0) {
        listContainer.innerHTML = '<p class="placeholder-text">Nessun bivacco trovato con i filtri attuali.</p>';
        updateMap([]);
        return;
    }

    // Ordinamento
    filtrati.sort((a, b) => {
        switch(sortBy) {
            case 'nome':
                return (a.tags.name || '').localeCompare(b.tags.name || '');
            case 'nome-desc':
                return (b.tags.name || '').localeCompare(a.tags.name || '');
            case 'alt-asc':
                return (parseInt(a.tags.ele || 0, 10)) - (parseInt(b.tags.ele || 0, 10));
            case 'alt-desc':
                return (parseInt(b.tags.ele || 0, 10)) - (parseInt(a.tags.ele || 0, 10));
            case 'temp-asc':
                return (parseInt(a.tags.temperature || 0, 10)) - (parseInt(b.tags.temperature || 0, 10));
            case 'temp-desc':
                return (parseInt(b.tags.temperature || 0, 10)) - (parseInt(a.tags.temperature || 0, 10));
            case 'dist-asc':
                if (currentUser && currentUser.home_address) {
                    const distA = calculateDistance(currentUser.home_address.lat, currentUser.home_address.lon, a.center?.lat ?? a.lat, a.center?.lon ?? a.lon);
                    const distB = calculateDistance(currentUser.home_address.lat, currentUser.home_address.lon, b.center?.lat ?? b.lat, b.center?.lon ?? b.lon);
                    return distA - distB;
                }
                return 0;
            case 'dist-desc':
                if (currentUser && currentUser.home_address) {
                    const distA = calculateDistance(currentUser.home_address.lat, currentUser.home_address.lon, a.center?.lat ?? a.lat, a.center?.lon ?? a.lon);
                    const distB = calculateDistance(currentUser.home_address.lat, currentUser.home_address.lon, b.center?.lat ?? b.lat, b.center?.lon ?? b.lon);
                    return distB - distA;
                }
                return 0;
            default:
                return 0;
        }
    });

    filtrati.forEach(el => {
        const item = document.createElement('div');
        item.className = 'bivacco-item';
        const isFavorite = currentUser && currentUser.favorites && currentUser.favorites.includes(el.id.toString());
        const heartColor = isFavorite ? '❤️' : '🤍';
        
        let distanceText = '';
        if (currentUser && currentUser.home_address) {
            const dist = calculateDistance(
                currentUser.home_address.lat,
                currentUser.home_address.lon,
                el.center?.lat ?? el.lat,
                el.center?.lon ?? el.lon
            );
            distanceText = ` | ${dist} km da casa`;
        }
        
        const temp = el.tags?.temperature !== undefined ? parseInt(el.tags.temperature, 10) : null;
        const tempDisplay = temp !== null ? `${temp}°C` : 'N/A';
        const snow = el.tags?.snow;
        const snowDisplay = snow === undefined ? '' : (snow ? ' | ❄️ Neve' : ' | ❄️ No neve');
        
        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <h4>${el.tags.name || 'Senza nome'}</h4>
                    <p>${el.tags.ele || 0}m | ${tempDisplay}${snowDisplay}${distanceText}</p>
                </div>
                ${currentUser ? `<button onclick="event.stopPropagation(); toggleFavorite('${el.id}')" class="heart-btn">${heartColor}</button>` : ''}
            </div>
        `;
        item.onclick = () => mostraDettagli(el);
        listContainer.appendChild(item);
    });

    // Aggiorna la mappa
    updateMap(filtrati);
}

// Funzione per aggiornare la mappa con i bivacchi filtrati
function updateMap(filtrati) {
    // Rimuovi marker esistenti
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];

    // Aggiungi marker della casa se impostato
    if (currentUser && currentUser.home_address) {
        // Rimuovi eventuale marker casa precedente
        if (homeMarker) {
            map.removeLayer(homeMarker);
            homeMarker = null;
        }
        homeMarker = L.marker([currentUser.home_address.lat, currentUser.home_address.lon], {
            icon: L.icon({
                iconUrl: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2YzOWMxMiIgZD0iTTEwIDIwdjYuOTM2bTAtNi45MzZWMGwxMiAxMHYxMEgxMHpNMTAgMjBIMHYtMTBsMTAtOHYxOHptOCAwdjZtLTQtNmgtNHYtNmg0djZ6Ii8+PC9zdmc+',
                iconSize: [32, 32],
                iconAnchor: [16, 32]
            })
        }).bindPopup('🏠 Casa').addTo(map);
    }

    // Aggiungi nuovi marker
    filtrati.forEach(el => {
        const lat = el.center?.lat ?? el.lat;
        const lon = el.center?.lon ?? el.lon;
        if (lat && lon) {
            const marker = L.marker([lat, lon]).addTo(map);
            marker.bindPopup(`<b>${el.tags.name || 'Bivacco'}</b><br>Altitudine: ${el.tags.ele || 0}m`);
            marker.on('click', () => mostraDettagli(el));
            markers.push(marker);
        }
    });

    // Adatta la vista SOLO al primo caricamento, non ad ogni filtro
    // E fallo solo quando la mappa è visibile (mobile può essere nascosta)
    if (!mapInitialized && markers.length > 0) {
        const group = new L.featureGroup(markers);
        if (isMapVisible()) {
            map.fitBounds(group.getBounds().pad(0.1));
            mapInitialized = true;
            mapFitPending = false;
        } else {
            // Rimanda il fit quando la mappa verrà mostrata
            mapFitPending = true;
        }
    }
}

// Funzione per mostrare il pannello di dettaglio
async function mostraDettagli(el) {
    const modal = document.getElementById('detail-view');
    const container = document.getElementById('detail-data');
    modal.style.display = "flex";
    container.innerHTML = "Caricamento dettagli...";

    const lat = el.center?.lat ?? el.lat;
    const lon = el.center?.lon ?? el.lon;
    let quota = el.tags.ele || 0;

    // Aggiorna temperature/min/max se mancanti o stale
    const lastTempUpdate = el.tags?.temperature_updated_at || 0;
    const tempStale = Date.now() - lastTempUpdate > WEATHER_STALE_MS;
    if (tempStale || el.tags?.temperature_min === undefined || el.tags?.temperature_max === undefined) {
        await fetchTemperature(el);
        try { localStorage.setItem('bivacchi-data', JSON.stringify(rawData)); } catch {}
    }

    let meteoInfo = "Non disponibile";
    if (lat && lon) {
        try {
            const resMeteo = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
            const dataM = await resMeteo.json();
            if (dataM.current_weather) {
                meteoInfo = `${dataM.current_weather.temperature}°C`;
            }
        } catch(e) {
            console.error("Errore API meteo:", e);
        }
    }

    // Costruisci la sezione dei dati aggiuntivi
    let additionalInfo = '';
    
    // Altezza (height)
    if (el.tags.height) {
        const heightVal = el.tags.height;
        const heightNum = parseFloat(heightVal);
        const heightDisplay = !isNaN(heightNum) ? `${heightNum} m` : heightVal;
        additionalInfo += `<p><strong>📏 Altezza:</strong> ${heightDisplay}</p>`;
    }
    
    // Descrizione (description)
    if (el.tags.description) {
        additionalInfo += `<p><strong>📝 Descrizione:</strong> ${el.tags.description}</p>`;
    }
    
    // Materassi (mattress)
    if (el.tags.mattress) {
        const mattressDisplay = el.tags.mattress === 'yes' ? 'Sì' : el.tags.mattress;
        additionalInfo += `<p><strong>🛏️ Materassi:</strong> ${mattressDisplay}</p>`;
    }
    
    // Capacità (capacity)
    if (el.tags.capacity) {
        additionalInfo += `<p><strong>👥 Capacità:</strong> ${el.tags.capacity} persone</p>`;
    }
    
    // Fireplace
    if (el.tags.fireplace) {
        const fireplaceDisplay = el.tags.fireplace === 'yes' ? 'Sì' : el.tags.fireplace;
        additionalInfo += `<p><strong>🔥 Camino:</strong> ${fireplaceDisplay}</p>`;
    }
    
    // Toilets (bagno)
    if (el.tags.toilets) {
        const toiletsDisplay = el.tags.toilets === 'yes' ? 'Sì' : el.tags.toilets;
        additionalInfo += `<p><strong>🚽 Bagno:</strong> ${toiletsDisplay}</p>`;
    }

    const tempMin = el.tags?.temperature_min;
    const tempMax = el.tags?.temperature_max;

    container.innerHTML = `
        <h2>${el.tags.name || "Bivacco"}</h2>
        <hr>
        <p><strong>🏔️ Altitudine:</strong> ${quota} m</p>
        ${el.tags?.sunrise && el.tags?.sunset ? `<p><strong>☀️ Ore di luce:</strong> Alba ${el.tags.sunrise} - Tramonto ${el.tags.sunset} (${el.tags.daylight_hours || 'N/A'}h)</p>` : ''}
        ${el.tags?.aspect_card || el.tags?.aspect_deg !== undefined ? `<p><strong>🧭 Esposizione:</strong> ${el.tags.aspect_card || ''}${el.tags?.aspect_deg !== undefined ? ` (${el.tags.aspect_deg}°)` : ''}</p>` : ''}
        ${el.tags?.slope_deg !== undefined ? `<p><strong>📐 Pendenza:</strong> ${el.tags.slope_deg}°</p>` : ''}
        <p><strong>🌡️ Temperatura attuale:</strong> ${meteoInfo}</p>
        ${(tempMin !== undefined || tempMax !== undefined) ? `<p><strong>🌡️ Min/Max oggi:</strong> ${tempMin !== undefined ? tempMin + '°C' : 'N/A'} / ${tempMax !== undefined ? tempMax + '°C' : 'N/A'}</p>` : ''}
        <p><strong>❄️ Neve nella zona:</strong> ${el.tags?.snow === true ? 'Sì' : (el.tags?.snow === false ? 'No' : 'N/A')}</p>
        ${lat && lon ? `<p><strong>📍 Coordinate:</strong> ${lat.toFixed(5)}, ${lon.toFixed(5)}</p>` : ''}
        <p><strong>🏠 Tipo:</strong> ${el.tags.shelter_type || el.tags.tourism || el.tags.building || 'Non specificato'}</p>
        ${additionalInfo ? `<hr>${additionalInfo}` : ''}
        <br>
        ${lat && lon ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" class="nav-btn">Portami qui</a>` : ''}
        <a href="https://www.openstreetmap.org/${el.type}/${el.id}" target="_blank" class="osm-btn">Vedi su OpenStreetMap</a>
        <hr>
        <div id="comments-section"></div>
    `;

    renderComments(el);
}

function formatDateTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleString('it-IT', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function renderComments(el) {
    const section = document.getElementById('comments-section');
    if (!section) return;
    section.innerHTML = '<p class="small-text">Caricamento commenti...</p>';

    let comments = [];
    try {
        const res = await fetch(`${API_BASE_URL}/api/bivacchi/${el.id}/comments`);
        if (res.ok) {
            comments = await res.json();
        } else {
            section.innerHTML = '<p class="form-error">Errore nel caricamento commenti.</p>';
            return;
        }
    } catch (e) {
        section.innerHTML = '<p class="form-error">Errore di rete nel caricamento commenti.</p>';
        return;
    }

    const commentsHtml = comments.length > 0
        ? comments.map(c => `
            <div class="comment-item">
                <div class="comment-header"><strong>${escapeHtml(c.userName || 'Utente')}</strong> · <span class="small-text">${formatDateTime(c.created_at)}</span></div>
                <p>${escapeHtml(c.text)}</p>
            </div>
        `).join('')
        : '<p class="small-text">Nessun commento ancora.</p>';

    const formHtml = currentUser ? `
        <div class="comment-form">
            <textarea id="comment-input" class="form-input" rows="3" placeholder="Scrivi un commento..."></textarea>
            <button id="comment-submit" class="form-btn">Invia commento</button>
        </div>
    ` : '<p class="small-text">Accedi per lasciare un commento.</p>';

    section.innerHTML = `
        <h4>Commenti</h4>
        <div id="comment-list">${commentsHtml}</div>
        ${formHtml}
    `;

    if (currentUser) {
        const btn = document.getElementById('comment-submit');
        const input = document.getElementById('comment-input');
        if (btn && input) {
            btn.onclick = async () => {
                const text = input.value.trim();
                if (!text) {
                    input.focus();
                    return;
                }
                btn.disabled = true;
                btn.innerText = 'Invio...';
                try {
                    const res = await fetch(`${API_BASE_URL}/api/bivacchi/${el.id}/comments`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text })
                    });
                    if (res.ok) {
                        input.value = '';
                        await renderComments(el); // reload list
                    } else {
                        const data = await res.json().catch(() => ({}));
                        alert(data.error || 'Errore nell\'invio del commento');
                    }
                } catch (e) {
                    alert('Errore di rete nell\'invio del commento');
                } finally {
                    btn.disabled = false;
                    btn.innerText = 'Invia commento';
                }
            };
        }
    }
}

// Event Listeners
['search-input', 'filter-dist-max', 'sort-by'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', debounce(aggiornaInterfaccia, 300));
    }
});

// Mobile filter listeners
['filter-dist-max-mobile', 'sort-by-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
        el.addEventListener('input', debounce(aggiornaInterfaccia, 300));
    }
});

document.getElementById('detail-view').addEventListener('click', function(e) {
    if (e.target === this) {
        this.style.display = 'none';
    }
});

// Funzione per inizializzare la mappa
function initMap() {
    // Forza sempre il livello di zoom iniziale corretto
    map = L.map('map', {
        zoomControl: true,
        zoomSnap: 1,
        zoomDelta: 1,
        minZoom: 5,
        maxZoom: 18,
        // Impedisce a Leaflet di gestire lo zoom touch in modo "aggressivo"
        touchZoom: true,
        scrollWheelZoom: true,
        doubleClickZoom: true,
        boxZoom: true,
        keyboard: true,
        // mobile: non bloccare lo zoom
        tap: false
    }).setView([46.2, 11.5], 7); // Centro Nord-Est Italia

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
}

// Avvio iniziale
async function initApp() {
    await checkAuth();
    initSliders();
    initMap();
    caricaDatiNordEst();
}
function initSliders() {
    const altEl = document.getElementById('altitude-slider');
    const tempEl = document.getElementById('temperature-slider');
    const altElMobile = document.getElementById('altitude-slider-mobile');
    const tempElMobile = document.getElementById('temperature-slider-mobile');
    
    if (altEl && window.noUiSlider) {
        altSlider = noUiSlider.create(altEl, {
            start: [0, 4000],
            connect: true,
            step: 100,
            range: { min: 0, max: 4000 },
            behaviour: 'drag'
        });
        const altMinSpan = document.getElementById('alt-min-val');
        const altMaxSpan = document.getElementById('alt-max-val');
        altSlider.on('update', (values) => {
            const [minV, maxV] = values.map(v => Math.round(parseFloat(v)));
            if (altMinSpan) altMinSpan.innerText = minV;
            if (altMaxSpan) altMaxSpan.innerText = maxV;
        });
        altSlider.on('set', debounce(aggiornaInterfaccia, 200));
    }
    
    if (tempEl && window.noUiSlider) {
        tempSlider = noUiSlider.create(tempEl, {
            start: [-20, 40],
            connect: true,
            step: 1,
            range: { min: -20, max: 40 },
            behaviour: 'drag'
        });
        const tMinSpan = document.getElementById('temp-min-val');
        const tMaxSpan = document.getElementById('temp-max-val');
        tempSlider.on('update', (values) => {
            const [minV, maxV] = values.map(v => Math.round(parseFloat(v)));
            if (tMinSpan) tMinSpan.innerText = minV;
            if (tMaxSpan) tMaxSpan.innerText = maxV;
        });
        tempSlider.on('set', debounce(aggiornaInterfaccia, 200));
    }
    
    // Mobile sliders
    let altSliderMobile = null;
    let tempSliderMobile = null;
    
    if (altElMobile && window.noUiSlider) {
        altSliderMobile = noUiSlider.create(altElMobile, {
            start: [0, 4000],
            connect: true,
            step: 100,
            range: { min: 0, max: 4000 },
            behaviour: 'drag'
        });
        const altMinSpanM = document.getElementById('alt-min-val-mobile');
        const altMaxSpanM = document.getElementById('alt-max-val-mobile');
        altSliderMobile.on('update', (values) => {
            const [minV, maxV] = values.map(v => Math.round(parseFloat(v)));
            if (altMinSpanM) altMinSpanM.innerText = minV;
            if (altMaxSpanM) altMaxSpanM.innerText = maxV;
            // Sync with desktop slider
            if (altSlider) altSlider.set([minV, maxV]);
        });
        altSliderMobile.on('set', debounce(aggiornaInterfaccia, 200));
    }
    
    if (tempElMobile && window.noUiSlider) {
        tempSliderMobile = noUiSlider.create(tempElMobile, {
            start: [-20, 40],
            connect: true,
            step: 1,
            range: { min: -20, max: 40 },
            behaviour: 'drag'
        });
        const tMinSpanM = document.getElementById('temp-min-val-mobile');
        const tMaxSpanM = document.getElementById('temp-max-val-mobile');
        tempSliderMobile.on('update', (values) => {
            const [minV, maxV] = values.map(v => Math.round(parseFloat(v)));
            if (tMinSpanM) tMinSpanM.innerText = minV;
            if (tMaxSpanM) tMaxSpanM.innerText = maxV;
            // Sync with desktop slider
            if (tempSlider) tempSlider.set([minV, maxV]);
        });
        tempSliderMobile.on('set', debounce(aggiornaInterfaccia, 200));
    }
}

initApp();

// Funzione per controllare autenticazione
async function checkAuth() {
    try {
        const res = await fetch(API_BASE_URL + '/api/me');
        if (res.ok) {
            const user = await res.json();
            if (user) {
                currentUser = user;
                updateAuthUI();
            }
        }
    } catch (e) {
        console.error("Errore verifica autenticazione:", e);
    }
}

function updateAuthUI() {
    const authArea = document.getElementById('auth-area');
    authArea.innerHTML = `
        <span class="user-name">${currentUser.name}</span>
        <button id="profile-btn" class="auth-btn">👤 Profilo</button>
    `;
    document.getElementById('profile-btn').addEventListener('click', () => {
        openProfileModal();
    });
}

function openAuthModal() {
    document.getElementById('auth-modal').style.display = 'flex';
    document.getElementById('auth-error').innerHTML = '';
}

function closeAuthModal() {
    document.getElementById('auth-modal').style.display = 'none';
    document.getElementById('auth-error').innerHTML = '';
}

function openProfileModal() {
    document.getElementById('profile-name').innerText = currentUser.name;
    document.getElementById('profile-email').innerText = currentUser.email;
    const date = new Date(currentUser.created_at);
    const formattedDate = date.toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' });
    document.getElementById('profile-date').innerText = formattedDate;
    
    // Indirizzo casa
    if (currentUser.home_address) {
        document.getElementById('profile-address').innerText = currentUser.home_address.address;
    } else {
        document.getElementById('profile-address').innerText = 'Non impostato';
    }

    // Preferiti
    loadFavorites();
    document.getElementById('profile-modal').style.display = 'flex';
}

function closeProfileModal() {
    document.getElementById('profile-modal').style.display = 'none';
}

function openAddressModal() {
    document.getElementById('address-modal').style.display = 'flex';
    setTimeout(() => {
        if (!addressMap) {
            addressMap = L.map('address-map').setView([46.2, 11.5], 7);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap contributors'
            }).addTo(addressMap);
            addressMap.on('click', (e) => {
                selectedCoords = e.latlng;
                document.getElementById('coords-display').innerText = `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
            });
        }
        addressMap.invalidateSize();
    }, 100);
}

function closeAddressModal() {
    document.getElementById('address-modal').style.display = 'none';
    selectedCoords = null;
}

function showRegister() {
    document.getElementById('auth-form').style.display = 'none';
    document.getElementById('register-form').style.display = 'block';
}

function showLogin() {
    document.getElementById('auth-form').style.display = 'block';
    document.getElementById('register-form').style.display = 'none';
}

async function handleLogin() {
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    if (!email || !password) {
        document.getElementById('auth-error').innerText = 'Compila tutti i campi';
        return;
    }

    try {
        const res = await fetch(API_BASE_URL + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            closeAuthModal();
            updateAuthUI();
            // Aggiorna UI se i dati sono già caricati
            if (dataLoaded) {
                aggiornaInterfaccia(); // Aggiorna UI per mostrare cuori
            }
            document.getElementById('auth-error').innerText = '';
        } else {
            document.getElementById('auth-error').innerText = data.error;
        }
    } catch (e) {
        document.getElementById('auth-error').innerText = 'Errore login';
    }
}

async function handleRegister() {
    const name = document.getElementById('register-name').value;
    const email = document.getElementById('register-email').value;
    const password = document.getElementById('register-password').value;

    if (!name || !email || !password) {
        document.getElementById('auth-error').innerText = 'Compila tutti i campi';
        return;
    }

    try {
        const res = await fetch(API_BASE_URL + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });

        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            closeAuthModal();
            updateAuthUI();
            // Aggiorna UI se i dati sono già caricati
            if (dataLoaded) {
                aggiornaInterfaccia(); // Aggiorna UI per mostrare cuori e feature da logged
            }
            document.getElementById('auth-error').innerText = '';
        } else {
            document.getElementById('auth-error').innerText = data.error;
        }
    } catch (e) {
        document.getElementById('auth-error').innerText = 'Errore registrazione';
    }
}

async function handleLogout() {
    try {
        const res = await fetch(API_BASE_URL + '/api/logout', { method: 'POST' });
        if (res.ok) {
            currentUser = null;
            closeProfileModal();
            document.getElementById('auth-area').innerHTML = '<button id="auth-btn" class="auth-btn">🔐 Accedi</button>';
            document.getElementById('auth-btn').addEventListener('click', openAuthModal);
            aggiornaInterfaccia(); // Aggiorna UI per nascondere cuori e feature da logged
        }
    } catch (e) {
        console.error("Errore logout:", e);
    }
}

// Event listener per pulsante accedi
document.getElementById('auth-btn').addEventListener('click', openAuthModal);

// Gestione pulsanti vista mobile (floating buttons)
const viewListMobile = document.getElementById('view-list-mobile');
const viewMapMobile = document.getElementById('view-map-mobile');

if (viewListMobile && viewMapMobile) {
    viewListMobile.addEventListener('click', () => {
        document.getElementById('bivacchi-list').style.display = 'block';
        document.getElementById('map').style.display = 'none';
        viewListMobile.classList.add('active');
        viewMapMobile.classList.remove('active');
    });

    viewMapMobile.addEventListener('click', () => {
        document.getElementById('bivacchi-list').style.display = 'none';
        document.getElementById('map').style.display = 'block';
        viewMapMobile.classList.add('active');
        viewListMobile.classList.remove('active');
        // Riadatta la mappa
        setTimeout(() => {
            if (map) {
                map.invalidateSize();
                // Se il fit era in sospeso (mappa nascosta), effettualo ora una volta
                if (mapFitPending && markers.length > 0) {
                    const group = new L.featureGroup(markers);
                    map.fitBounds(group.getBounds().pad(0.1));
                    mapInitialized = true;
                    mapFitPending = false;
                }
            }
        }, 100);
    });
}

// Mobile filter button handler
const mobileFilterBtn = document.getElementById('mobile-filter-btn');
if (mobileFilterBtn) {
    mobileFilterBtn.addEventListener('click', openMobileFilters);
}

function openMobileFilters() {
    document.getElementById('mobile-filters-modal').style.display = 'flex';
}

function closeMobileFilters() {
    document.getElementById('mobile-filters-modal').style.display = 'none';
}

// Funzioni per preferiti e indirizzo casa
async function toggleFavorite(bivaccoId) {
    if (!currentUser) {
        openAuthModal();
        return;
    }

    try {
        const res = await fetch(`/api/favorites/${bivaccoId}`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            currentUser.favorites = data.favorites;
            aggiornaInterfaccia();
        }
    } catch (e) {
        console.error("Errore toggle preferito:", e);
    }
}

function loadFavorites() {
    const favoritesList = document.getElementById('favorites-list');
    if (!currentUser.favorites || currentUser.favorites.length === 0) {
        favoritesList.innerHTML = '<p>Nessun bivacco preferito</p>';
        return;
    }

    const favBivacchi = rawData.filter(el => currentUser.favorites.includes(el.id.toString()));
    if (favBivacchi.length === 0) {
        favoritesList.innerHTML = '<p>Nessun bivacco preferito</p>';
        return;
    }

    favoritesList.innerHTML = favBivacchi.map(el => `
        <div class="favorite-item">
            <span class="favorite-item-name">${el.tags.name} (${el.tags.ele || 0}m)</span>
            <button onclick="removeFavorite('${el.id}')" class="favorite-remove">✕</button>
        </div>
    `).join('');
}

async function removeFavorite(bivaccoId) {
    await toggleFavorite(bivaccoId);
    loadFavorites();
}

async function handleSaveAddress() {
    const address = document.getElementById('address-input').value;
    
    if (!address || !selectedCoords) {
        document.getElementById('address-error').innerText = 'Compila indirizzo e seleziona coordinata sulla mappa';
        return;
    }

    try {
        const res = await fetch(API_BASE_URL + '/api/home-address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                address,
                lat: selectedCoords.lat,
                lon: selectedCoords.lng
            })
        });

        if (res.ok) {
            const data = await res.json();
            currentUser.home_address = data.home_address;
            closeAddressModal();
            openProfileModal();
            aggiornaInterfaccia();
        }
    } catch (e) {
        document.getElementById('address-error').innerText = 'Errore salvataggio indirizzo';
    }
}

// Funzione per calcolare distanza tra due punti (Haversine formula)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Raggio terrestre in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return Math.round(R * c * 10) / 10; // km
}
