# Usa una versione leggera di Node.js
FROM node:20-alpine

# Crea la cartella di lavoro nel container
WORKDIR /app

# Copia i file dei pacchetti e installa le dipendenze
COPY package*.json ./
RUN npm install

# Copia tutto il resto del codice
COPY . .

# Espone la porta che usa la tua app (es. 3000)
EXPOSE 3000

# Comando per avviare l'app
CMD ["npm", "start"]