const express = require('express');
const fs = require('fs');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'bivacchi_veneto.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const COMMENTS_FILE = path.join(__dirname, 'comments.json');

// Lista regioni italiane con bounding box approssimativo
const REGIONI_ITALIA = {
    'Valle d\'Aosta': { minLat: 45.47, maxLat: 45.99, minLon: 6.80, maxLon: 7.95 },
    'Piemonte': { minLat: 44.06, maxLat: 46.46, minLon: 6.63, maxLon: 9.21 },
    'Lombardia': { minLat: 44.68, maxLat: 46.64, minLon: 8.50, maxLon: 11.43 },
    'Trentino-Alto Adige': { minLat: 45.67, maxLat: 47.09, minLon: 10.38, maxLon: 12.48 },
    'Veneto': { minLat: 44.79, maxLat: 46.68, minLon: 10.62, maxLon: 13.10 },
    'Friuli-Venezia Giulia': { minLat: 45.58, maxLat: 46.65, minLon: 12.29, maxLon: 13.92 },
    'Liguria': { minLat: 43.78, maxLat: 44.68, minLon: 7.50, maxLon: 10.07 },
    'Emilia-Romagna': { minLat: 43.73, maxLat: 45.14, minLon: 9.20, maxLon: 12.76 },
    'Toscana': { minLat: 42.24, maxLat: 44.47, minLon: 9.69, maxLon: 12.37 },
    'Umbria': { minLat: 42.37, maxLat: 43.62, minLon: 12.09, maxLon: 13.26 },
    'Marche': { minLat: 42.69, maxLat: 43.97, minLon: 11.69, maxLon: 13.92 },
    'Lazio': { minLat: 41.19, maxLat: 42.84, minLon: 11.45, maxLon: 14.03 },
    'Abruzzo': { minLat: 41.68, maxLat: 42.90, minLon: 13.02, maxLon: 14.79 },
    'Molise': { minLat: 41.35, maxLat: 42.07, minLon: 13.93, maxLon: 15.16 },
    'Campania': { minLat: 39.99, maxLat: 41.51, minLon: 13.76, maxLon: 15.81 },
    'Puglia': { minLat: 39.79, maxLat: 42.23, minLon: 15.34, maxLon: 18.52 },
    'Basilicata': { minLat: 39.90, maxLat: 41.14, minLon: 15.34, maxLon: 16.87 },
    'Calabria': { minLat: 37.92, maxLat: 40.14, minLon: 15.63, maxLon: 17.21 },
    'Sicilia': { minLat: 36.64, maxLat: 38.82, minLon: 12.37, maxLon: 15.65 },
    'Sardegna': { minLat: 38.86, maxLat: 41.31, minLon: 8.13, maxLon: 9.83 }
};

// Funzione per verificare se un punto è dentro l'Italia
// Usa un controllo a due livelli: prima bbox grossolano, poi verifica regione specifica
function isInItaly(lat, lon) {
    // Controllo bbox Italia grossolano (include un po' di margine)
    if (lat < 35.5 || lat > 47.5 || lon < 6.5 || lon > 18.8) {
        return false;
    }
    
    // Controlla se è dentro almeno una regione
    for (const regione of Object.values(REGIONI_ITALIA)) {
        if (lat >= regione.minLat && lat <= regione.maxLat &&
            lon >= regione.minLon && lon <= regione.maxLon) {
            return true;
        }
    }
    
    // Se non è in nessuna regione ma è dentro il bbox grossolano,
    // potrebbe essere in un'area di confine - accetta con margine
    // (gestisce zone di confine alpino)
    const MARGIN = 0.15; // ~15km di margine
    for (const regione of Object.values(REGIONI_ITALIA)) {
        if (lat >= regione.minLat - MARGIN && lat <= regione.maxLat + MARGIN &&
            lon >= regione.minLon - MARGIN && lon <= regione.maxLon + MARGIN) {
            return true;
        }
    }
    
    return false;
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));
app.use(cors());
app.use(session({
    secret: process.env.SESSION_SECRET || 'bivacchi-secret-key-2026',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 ore
}));

// ============================================
// MIDDLEWARE DI AUTORIZZAZIONE
// ============================================

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Non autenticato' });
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Non autenticato' });
    }
    const users = loadUsers();
    const user = users.find(u => u.id === req.session.userId);
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Accesso negato - richiesto ruolo admin' });
    }
    req.user = user;
    next();
}

// Favicon placeholder per evitare 404
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Funzione per caricare utenti
function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data);
    }
    return [];
}

// Funzione per salvare utenti
function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

function loadComments() {
    if (fs.existsSync(COMMENTS_FILE)) {
        const data = fs.readFileSync(COMMENTS_FILE, 'utf8');
        return JSON.parse(data);
    }
    return {};
}

function saveComments(comments) {
    fs.writeFileSync(COMMENTS_FILE, JSON.stringify(comments, null, 2), 'utf8');
}

// Endpoint per registrazione
app.post('/api/register', (req, res) => {
    const { email, password, name } = req.body;
    
    if (!email || !password || !name) {
        return res.status(400).json({ error: 'Campi obbligatori mancanti' });
    }

    const users = loadUsers();
    
    if (users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Email già registrata' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    const newUser = {
        id: Date.now().toString(),
        email,
        password: hashedPassword,
        name,
        created_at: new Date().toISOString()
    };

    users.push(newUser);
    saveUsers(users);

    req.session.userId = newUser.id;
    res.json({ success: true, user: { 
        id: newUser.id, 
        email, 
        name,
        favorites: [],
        home_address: null
    }});
});

// Endpoint per login
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email e password obbligatori' });
    }

    const users = loadUsers();
    const user = users.find(u => u.email === email);

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: 'Credenziali non valide' });
    }

    req.session.userId = user.id;
    res.json({ success: true, user: { 
        id: user.id, 
        email: user.email, 
        name: user.name,
        role: user.role || 'user',
        favorites: user.favorites || [],
        home_address: user.home_address || null
    }});
});

// Endpoint per logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).json({ error: 'Errore logout' });
        }
        res.json({ success: true });
    });
});

// Endpoint per ottenere utente corrente
app.get('/api/me', (req, res) => {
    if (!req.session.userId) {
        return res.json(null);
    }

    const users = loadUsers();
    const user = users.find(u => u.id === req.session.userId);

    if (!user) {
        return res.json(null);
    }

    res.json({ 
        id: user.id, 
        email: user.email, 
        name: user.name, 
        role: user.role || 'user',
        created_at: user.created_at,
        favorites: user.favorites || [],
        home_address: user.home_address || null
    });
});

// Endpoint per aggiungere/rimuovere da preferiti
app.post('/api/favorites/:id', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Non autenticato' });
    }

    const users = loadUsers();
    const user = users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'Utente non trovato' });
    }

    if (!user.favorites) user.favorites = [];
    
    const bivaccoId = req.params.id;
    const index = user.favorites.indexOf(bivaccoId);
    
    if (index > -1) {
        user.favorites.splice(index, 1);
    } else {
        user.favorites.push(bivaccoId);
    }

    saveUsers(users);
    res.json({ favorites: user.favorites });
});

// Endpoint per impostare indirizzo casa
app.post('/api/home-address', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Non autenticato' });
    }

    const users = loadUsers();
    const user = users.find(u => u.id === req.session.userId);
    
    if (!user) {
        return res.status(404).json({ error: 'Utente non trovato' });
    }

    const { address, lat, lon } = req.body;
    user.home_address = { address, lat, lon };

    saveUsers(users);
    res.json({ home_address: user.home_address });
});

// Commenti per bivacchi
app.get('/api/bivacchi/:id/comments', (req, res) => {
    const comments = loadComments();
    const list = comments[req.params.id] || [];
    res.json(list);
});

app.post('/api/bivacchi/:id/comments', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Non autenticato' });
    }
    const text = (req.body.text || '').toString().trim();
    if (!text) {
        return res.status(400).json({ error: 'Commento vuoto' });
    }
    if (text.length > 1000) {
        return res.status(400).json({ error: 'Commento troppo lungo (max 1000 caratteri)' });
    }

    const users = loadUsers();
    const user = users.find(u => u.id === req.session.userId);
    if (!user) {
        return res.status(401).json({ error: 'Utente non valido' });
    }

    const comments = loadComments();
    if (!comments[req.params.id]) comments[req.params.id] = [];
    const newComment = {
        id: Date.now().toString(),
        userId: user.id,
        userName: user.name,
        text,
        created_at: new Date().toISOString()
    };
    comments[req.params.id].push(newComment);
    saveComments(comments);
    res.json(newComment);
});

// Endpoint per ottenere bivacchi
app.get('/api/bivacchi', (req, res) => {
    if (fs.existsSync(DATA_FILE)) {
        fs.readFile(DATA_FILE, 'utf8', (err, data) => {
            if (err) {
                return res.status(500).json({ error: 'Errore lettura dati' });
            }
            res.json(JSON.parse(data));
        });
    } else {
        res.json([]);
    }
});

// Endpoint per salvare bivacchi (PROTETTO - solo admin)
app.post('/api/bivacchi', requireAdmin, (req, res) => {
    const data = req.body;
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
        if (err) {
            return res.status(500).json({ error: 'Errore salvataggio dati' });
        }
        res.json({ success: true });
    });
});

// ============================================
// API ADMIN
// ============================================

// Endpoint per lista regioni
app.get('/api/regioni', (req, res) => {
    res.json(Object.keys(REGIONI_ITALIA));
});

// Statistiche admin
app.get('/api/admin/stats', requireAdmin, (req, res) => {
    const bivacchi = loadBivacchi();
    const users = loadUsers();
    const comments = loadComments();
    
    const totalComments = Object.values(comments).reduce((sum, arr) => sum + arr.length, 0);
    
    // Conta bivacchi per regione
    const perRegione = {};
    bivacchi.forEach(b => {
        const regione = detectRegione(b.lat, b.lon);
        perRegione[regione] = (perRegione[regione] || 0) + 1;
    });
    
    res.json({
        totalBivacchi: bivacchi.length,
        totalUsers: users.length,
        totalComments,
        bivacchiPerRegione: perRegione,
        regioni: Object.keys(REGIONI_ITALIA)
    });
});

// Lista utenti (admin)
app.get('/api/admin/users', requireAdmin, (req, res) => {
    const users = loadUsers();
    // Non esporre password
    const safeUsers = users.map(u => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role || 'user',
        created_at: u.created_at,
        favoritesCount: (u.favorites || []).length
    }));
    res.json(safeUsers);
});

// Cambia ruolo utente (admin)
app.put('/api/admin/users/:id/role', requireAdmin, (req, res) => {
    const { role } = req.body;
    if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Ruolo non valido' });
    }
    
    const users = loadUsers();
    const user = users.find(u => u.id === req.params.id);
    if (!user) {
        return res.status(404).json({ error: 'Utente non trovato' });
    }
    
    user.role = role;
    saveUsers(users);
    res.json({ success: true, user: { id: user.id, role: user.role } });
});

// Lista bivacchi con paginazione e ricerca (admin)
app.get('/api/admin/bivacchi', requireAdmin, (req, res) => {
    const bivacchi = loadBivacchi();
    const { search = '', page = 1, limit = 50 } = req.query;
    
    let filtered = bivacchi;
    if (search) {
        const searchLower = search.toLowerCase();
        filtered = bivacchi.filter(b => 
            (b.name && b.name.toLowerCase().includes(searchLower)) ||
            (b.id && String(b.id).includes(searchLower))
        );
    }
    
    const total = filtered.length;
    const startIndex = (parseInt(page) - 1) * parseInt(limit);
    const paginated = filtered.slice(startIndex, startIndex + parseInt(limit));
    
    res.json({
        bivacchi: paginated,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit))
    });
});

// Aggiungi singolo bivacco (admin)
app.post('/api/admin/bivacchi', requireAdmin, (req, res) => {
    const bivacco = req.body;
    
    if (!bivacco.lat || !bivacco.lon) {
        return res.status(400).json({ error: 'Coordinate obbligatorie' });
    }
    
    const bivacchi = loadBivacchi();
    
    // Genera ID se non presente
    if (!bivacco.id) {
        bivacco.id = Date.now();
    }
    
    // Verifica duplicato
    if (bivacchi.find(b => b.id === bivacco.id)) {
        return res.status(400).json({ error: 'Bivacco con questo ID già esistente' });
    }
    
    bivacchi.push(bivacco);
    saveBivacchi(bivacchi);
    
    res.json({ success: true, bivacco });
});

// Modifica bivacco (admin)
app.put('/api/admin/bivacchi/:id', requireAdmin, (req, res) => {
    const bivacchi = loadBivacchi();
    const index = bivacchi.findIndex(b => String(b.id) === req.params.id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Bivacco non trovato' });
    }
    
    // Merge dati esistenti con nuovi
    bivacchi[index] = { ...bivacchi[index], ...req.body, id: bivacchi[index].id };
    saveBivacchi(bivacchi);
    
    res.json({ success: true, bivacco: bivacchi[index] });
});

// Elimina bivacco (admin)
app.delete('/api/admin/bivacchi/:id', requireAdmin, (req, res) => {
    const bivacchi = loadBivacchi();
    const index = bivacchi.findIndex(b => String(b.id) === req.params.id);
    
    if (index === -1) {
        return res.status(404).json({ error: 'Bivacco non trovato' });
    }
    
    const deleted = bivacchi.splice(index, 1)[0];
    saveBivacchi(bivacchi);
    
    // Rimuovi anche i commenti associati
    const comments = loadComments();
    delete comments[req.params.id];
    saveComments(comments);
    
    res.json({ success: true, deleted });
});

// Elimina commento (admin)
app.delete('/api/admin/comments/:bivaccoId/:commentId', requireAdmin, (req, res) => {
    const comments = loadComments();
    const { bivaccoId, commentId } = req.params;
    
    if (!comments[bivaccoId]) {
        return res.status(404).json({ error: 'Nessun commento per questo bivacco' });
    }
    
    const index = comments[bivaccoId].findIndex(c => c.id === commentId);
    if (index === -1) {
        return res.status(404).json({ error: 'Commento non trovato' });
    }
    
    const deleted = comments[bivaccoId].splice(index, 1)[0];
    saveComments(comments);
    
    res.json({ success: true, deleted });
});

// ============================================
// IMPORT DA OPENSTREETMAP (OVERPASS API)
// ============================================

// Importa bivacchi da Overpass API (admin)
app.post('/api/admin/import-osm', requireAdmin, async (req, res) => {
    const { query, regione, testMode } = req.body;
    
    // Query di default: bivacchi veri (con "bivacco" nel nome o wilderness_hut basic_hut)
    let overpassQuery = query;
    
    if (!overpassQuery) {
        // Usa area amministrativa invece di bbox per precisione
        let areaFilter;
        
        if (regione && REGIONI_ITALIA[regione]) {
            // Per regione specifica, usa area regionale
            areaFilter = `area["name"="${regione}"]["admin_level"="4"]->.searchArea`;
        } else {
            // Per tutta Italia, usa il confine nazionale
            areaFilter = 'area["ISO3166-1"="IT"]->.searchArea';
        }
        
        // Query più selettiva: solo bivacchi veri
        overpassQuery = `
            [out:json][timeout:300];
            ${areaFilter};
            (
                node["name"~"[Bb]ivacco|[Bb]ivouac"](area.searchArea);
                node["tourism"="wilderness_hut"]["shelter_type"="basic_hut"](area.searchArea);
                way["name"~"[Bb]ivacco|[Bb]ivouac"](area.searchArea);
                way["tourism"="wilderness_hut"]["shelter_type"="basic_hut"](area.searchArea);
            );
            out center meta;
        `;
    }
    
    console.log('[OSM Import] Starting import...');
    console.log('[OSM Import] Query:', overpassQuery.substring(0, 200) + '...');
    
    try {
        // Usa fetch nativo di Node 18+
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180000); // 3 minuti timeout
        
        const response = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(overpassQuery),
            signal: controller.signal
        });
        
        clearTimeout(timeout);
        
        if (!response.ok) {
            throw new Error(`Overpass API error: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        console.log('[OSM Import] Received', data.elements?.length || 0, 'elements');
        
        if (!data.elements || data.elements.length === 0) {
            return res.json({ 
                success: true, 
                imported: 0, 
                skipped: 0,
                message: 'Nessun risultato trovato con questa query' 
            });
        }
        
        // Converti elementi OSM nel nostro formato con filtri stringenti
        const newBivacchi = data.elements.map(el => {
            // Per way/relation, usa il centro
            const lat = el.lat || el.center?.lat;
            const lon = el.lon || el.center?.lon;
            
            if (!lat || !lon) return null;
            
            const name = el.tags?.name || '';
            
            // FILTRO STRINGENTE: deve avere "bivacco" o "bivouac" nel nome
            // OPPURE essere wilderness_hut con shelter_type=basic_hut
            const hasBivaccoInName = /bivacco|bivouac/i.test(name);
            const isWildernessBasicHut = el.tags?.tourism === 'wilderness_hut' && 
                                        el.tags?.shelter_type === 'basic_hut';
            
            if (!hasBivaccoInName && !isWildernessBasicHut) {
                return null; // Escludi shelter generici, casere, baite, rifugi, etc.
            }
            
            return {
                type: el.type,
                id: el.id,
                lat,
                lon,
                tags: {
                    name: name || 'Bivacco senza nome',
                    ele: el.tags?.ele || el.tags?.altitude || null,
                    amenity: el.tags?.amenity,
                    tourism: el.tags?.tourism,
                    shelter_type: el.tags?.shelter_type,
                    fireplace: el.tags?.fireplace,
                    beds: el.tags?.beds,
                    capacity: el.tags?.capacity,
                    drinking_water: el.tags?.drinking_water,
                    description: el.tags?.description,
                    website: el.tags?.website,
                    phone: el.tags?.phone,
                    opening_hours: el.tags?.opening_hours,
                    access: el.tags?.access,
                    fee: el.tags?.fee,
                    operator: el.tags?.operator,
                    source: 'openstreetmap',
                    osm_id: el.id,
                    imported_at: new Date().toISOString()
                }
            };
        }).filter(b => b !== null && isInItaly(b.lat, b.lon)); // Filtra bivacchi fuori Italia
        
        console.log('[OSM Import] Converted', newBivacchi.length, 'valid bivacchi in Italy');
        
        if (testMode) {
            // In test mode, ritorna solo preview senza salvare
            return res.json({
                success: true,
                testMode: true,
                preview: newBivacchi.slice(0, 20),
                totalFound: newBivacchi.length
            });
        }
        
        // Carica bivacchi esistenti e fai merge
        const existingBivacchi = loadBivacchi();
        const existingIds = new Set(existingBivacchi.map(b => b.id));
        
        let imported = 0;
        let skipped = 0;
        
        newBivacchi.forEach(b => {
            if (existingIds.has(b.id)) {
                skipped++;
            } else {
                existingBivacchi.push(b);
                imported++;
            }
        });
        
        saveBivacchi(existingBivacchi);
        
        console.log('[OSM Import] Imported:', imported, 'Skipped:', skipped);
        
        res.json({
            success: true,
            imported,
            skipped,
            total: existingBivacchi.length
        });
        
    } catch (error) {
        console.error('[OSM Import] Error:', error.message);
        
        if (error.name === 'AbortError') {
            return res.status(504).json({ error: 'Timeout - la query ha impiegato troppo tempo. Prova con una regione più piccola.' });
        }
        
        res.status(500).json({ error: 'Errore import: ' + error.message });
    }
});

// Elimina tutti i bivacchi (admin) - con conferma
app.delete('/api/admin/bivacchi', requireAdmin, (req, res) => {
    const { confirm } = req.body;
    
    if (confirm !== 'DELETE_ALL') {
        return res.status(400).json({ error: 'Conferma richiesta. Invia { confirm: "DELETE_ALL" }' });
    }
    
    saveBivacchi([]);
    res.json({ success: true, message: 'Tutti i bivacchi eliminati' });
});

// Endpoint per pulire bivacchi fuori Italia
app.post('/api/admin/cleanup-outside-italy', requireAdmin, (req, res) => {
    const bivacchi = loadBivacchi();
    const before = bivacchi.length;
    
    const cleaned = bivacchi.filter(b => {
        const lat = b.center?.lat ?? b.lat;
        const lon = b.center?.lon ?? b.lon;
        return isInItaly(lat, lon);
    });
    
    const removed = before - cleaned.length;
    
    if (removed > 0) {
        saveBivacchi(cleaned);
    }
    
    console.log(`[Cleanup] Removed ${removed} bivacchi outside Italy`);
    res.json({ 
        success: true, 
        removed, 
        remaining: cleaned.length,
        message: `Rimossi ${removed} bivacchi fuori dall'Italia` 
    });
});

// Endpoint per pulire bivacchi non validi (senza "bivacco" nel nome)
app.post('/api/admin/cleanup-invalid', requireAdmin, (req, res) => {
    const bivacchi = loadBivacchi();
    const before = bivacchi.length;
    
    const cleaned = bivacchi.filter(b => {
        const name = (b.tags?.name || '').toLowerCase().trim();
        
        // ESCLUDI: elementi che non sono bivacchi
        // 1. Sentieri/percorsi
        if (name.startsWith('sentiero') || name.startsWith('sentriero')) return false;
        if (name.includes('percorso') || name.includes('via ferrata')) return false;
        
        // 2. Waypoint numerici senza tourism (es. "1050 Bivacco Marsini")
        if (/^\d+\s/.test(name) && !b.tags?.tourism) return false;
        
        // 3. Contrade e località
        if (name.startsWith('contrada')) return false;
        
        // Mantieni solo se:
        // 1. Ha "bivacco" o "bivouac" nel nome
        // 2. Oppure è wilderness_hut con shelter_type=basic_hut
        const hasBivaccoInName = /bivacco|bivouac/i.test(name);
        const isWildernessBasicHut = b.tags?.tourism === 'wilderness_hut' && 
                                     b.tags?.shelter_type === 'basic_hut';
        
        return hasBivaccoInName || isWildernessBasicHut;
    });
    
    const removed = before - cleaned.length;
    
    if (removed > 0) {
        saveBivacchi(cleaned);
    }
    
    console.log(`[Cleanup] Removed ${removed} invalid bivacchi`);
    res.json({ 
        success: true, 
        removed, 
        remaining: cleaned.length,
        message: `Rimossi ${removed} elementi non validi (sentieri, waypoint, casere, baite, rifugi, etc.)` 
    });
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function loadBivacchi() {
    if (fs.existsSync(DATA_FILE)) {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    }
    return [];
}

function saveBivacchi(bivacchi) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(bivacchi, null, 2), 'utf8');
}

function detectRegione(lat, lon) {
    for (const [regione, bounds] of Object.entries(REGIONI_ITALIA)) {
        if (lat >= bounds.minLat && lat <= bounds.maxLat &&
            lon >= bounds.minLon && lon <= bounds.maxLon) {
            return regione;
        }
    }
    return 'Altro';
}

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Admin portal: http://localhost:${PORT}/admin.html`);
});