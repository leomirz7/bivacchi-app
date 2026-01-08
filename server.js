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

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use(cors());
app.use(session({
    secret: 'bivacchi-secret-key-2026',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 ore
}));

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

// Endpoint per salvare bivacchi
app.post('/api/bivacchi', (req, res) => {
    const data = req.body;
    fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8', (err) => {
        if (err) {
            return res.status(500).json({ error: 'Errore salvataggio dati' });
        }
        res.json({ success: true });
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});