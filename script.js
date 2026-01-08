function debounce(func, wait) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), wait);
    };
}

let rawData = [];
const listContainer = document.getElementById('bivacchi-list');
let map;
let markers = [];
let currentUser = null;
let addressMap = null;
let selectedCoords = null;

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

// Funzione per ottenere temperature per i bivacchi
async function fetchTemperaturesForAll(data) {
    for (const el of data) {
        const lat = el.center?.lat ?? el.lat;
        const lon = el.center?.lon ?? el.lon;
        if (!lat || !lon) continue;
        
        try {
            const resMeteo = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`);
            const dataMeteo = await resMeteo.json();
            if (dataMeteo.current_weather && dataMeteo.current_weather.temperature !== undefined) {
                el.tags.temperature = Math.round(dataMeteo.current_weather.temperature);
            } else {
                el.tags.temperature = undefined;
            }
        } catch(e) {
            console.error(`Errore temperatura per ${lat},${lon}:`, e);
            el.tags.temperature = undefined;
        }
        
        // Delay tra richieste per non sovraccaricare l'API
        await new Promise(resolve => setTimeout(resolve, 300));
    }
}

// Funzione per caricare i dati dei bivacchi nel Nord-Est Italia
async function caricaDatiNordEst() {
    listContainer.innerHTML = '<p class="placeholder-text">Caricamento bivacchi dal server...</p>';

    try {
        const res = await fetch('/api/bivacchi');
        if (res.ok) {
            const data = await res.json();
            if (data.length > 0) {
                rawData = data;
                // Verifica se i dati includono Trentino e Friuli
                const hasTrentino = data.some(el => (el.center?.lat ?? el.lat) > 46.5);
                const hasFriuli = data.some(el => (el.center?.lon ?? el.lon) > 13);
                if (hasTrentino && hasFriuli) {
                    listContainer.innerHTML = '<p class="placeholder-text">Caricamento temperature dai dati in cache...</p>';
                    // Anche con i dati in cache, assicurati di avere le temperature aggiornate
                    await fetchTemperaturesForAll(rawData);
                    // Salva i dati con le temperature aggiornate
                    await fetch('/api/bivacchi', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(rawData)
                    });
                    aggiornaInterfaccia();
                    return;
                } else {
                    console.log("Dati incompleti, scarico aggiornamenti...");
                }
            }
        }
    } catch (e) {
        console.error("Errore caricamento da server:", e);
    }

    // Se non ci sono dati sul server, carica da API
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

        // Ottieni temperature per TUTTI i bivacchi
        listContainer.innerHTML = '<p class="placeholder-text">Caricamento temperature...</p>';
        await fetchTemperaturesForAll(rawData);

        // Salva sul server
        await fetch('/api/bivacchi', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(rawData)
        });

        aggiornaInterfaccia();
    } catch (e) {
        console.error("Errore Overpass API:", e);
        listContainer.innerHTML = `<p class="placeholder-text error">${e.message}</p><button id="retry-btn" onclick="caricaDatiVeneto()">Riprova</button>`;
    }
}

// Funzione per aggiornare la lista
function aggiornaInterfaccia() {
    const searchTerm = document.getElementById('search-input').value.toLowerCase();
    const minAlt = parseInt(document.getElementById('filter-alt-min').value, 10);
    const maxAlt = parseInt(document.getElementById('filter-alt-max').value, 10);
    const minTemp = parseInt(document.getElementById('filter-temp-min').value, 10);
    const maxTemp = parseInt(document.getElementById('filter-temp-max').value, 10);
    const maxDist = parseInt(document.getElementById('filter-dist-max').value, 10);
    const sortBy = document.getElementById('sort-by').value;
    
    document.getElementById('alt-min-val').innerText = minAlt;
    document.getElementById('alt-max-val').innerText = maxAlt;
    document.getElementById('temp-min-val').innerText = minTemp;
    document.getElementById('temp-max-val').innerText = maxTemp;
    document.getElementById('dist-max-val').innerText = maxDist;

    // Mostra filtro distanza solo se utente loggato con indirizzo impostato
    const distanceFilterGroup = document.getElementById('distance-filter-group');
    if (currentUser && currentUser.home_address) {
        distanceFilterGroup.style.display = 'block';
    } else {
        distanceFilterGroup.style.display = 'none';
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
        
        item.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <h4>${el.tags.name || 'Senza nome'}</h4>
                    <p>${el.tags.ele || 0}m | ${tempDisplay}${distanceText}</p>
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
        L.marker([currentUser.home_address.lat, currentUser.home_address.lon], {
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

    // Adatta la vista se ci sono marker
    if (markers.length > 0) {
        const group = new L.featureGroup(markers);
        map.fitBounds(group.getBounds().pad(0.1));
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

    container.innerHTML = `
        <h2>${el.tags.name || "Bivacco"}</h2>
        <hr>
        <p><strong>🏔️ Altitudine:</strong> ${quota} m</p>
        <p><strong>🌡️ Meteo attuale:</strong> ${meteoInfo}</p>
        ${lat && lon ? `<p><strong>📍 Coordinate:</strong> ${lat.toFixed(5)}, ${lon.toFixed(5)}</p>` : ''}
        <p><strong>🏠 Tipo:</strong> ${el.tags.shelter_type || el.tags.tourism || el.tags.building || 'Non specificato'}</p>
        <br>
        ${lat && lon ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}" target="_blank" class="nav-btn">Portami qui</a>` : ''}
        <a href="https://www.openstreetmap.org/${el.type}/${el.id}" target="_blank" class="osm-btn">Vedi su OpenStreetMap</a>
    `;
}

// Event Listeners
['search-input', 'filter-alt-min', 'filter-alt-max', 'filter-temp-min', 'filter-temp-max', 'filter-dist-max', 'sort-by'].forEach(id => {
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
    map = L.map('map').setView([46.2, 11.5], 7); // Centro Nord-Est Italia

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
}

// Avvio iniziale
checkAuth();
initMap();
caricaDatiNordEst();

// Funzione per controllare autenticazione
async function checkAuth() {
    try {
        const res = await fetch('/api/me');
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
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            closeAuthModal();
            updateAuthUI();
            aggiornaInterfaccia(); // Aggiorna UI per mostrare cuori
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
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, email, password })
        });

        const data = await res.json();
        if (res.ok) {
            currentUser = data.user;
            closeAuthModal();
            updateAuthUI();
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
        const res = await fetch('/api/logout', { method: 'POST' });
        if (res.ok) {
            currentUser = null;
            closeProfileModal();
            document.getElementById('auth-area').innerHTML = '<button id="auth-btn" class="auth-btn">🔐 Accedi</button>';
            document.getElementById('auth-btn').addEventListener('click', openAuthModal);
        }
    } catch (e) {
        console.error("Errore logout:", e);
    }
}

// Event listener per pulsante accedi
document.getElementById('auth-btn').addEventListener('click', openAuthModal);

// Gestione pulsanti vista mobile
document.getElementById('view-list').classList.add('active');
document.getElementById('view-list').addEventListener('click', () => {
    document.getElementById('bivacchi-list').style.display = 'block';
    document.getElementById('map').style.display = 'none';
    document.getElementById('view-list').classList.add('active');
    document.getElementById('view-map').classList.remove('active');
});

document.getElementById('view-map').addEventListener('click', () => {
    document.getElementById('bivacchi-list').style.display = 'none';
    document.getElementById('map').style.display = 'block';
    document.getElementById('view-map').classList.add('active');
    document.getElementById('view-list').classList.remove('active');
    // Riadatta la mappa
    setTimeout(() => map.invalidateSize(), 100);
});

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
        const res = await fetch('/api/home-address', {
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
