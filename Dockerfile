# Usa un'immagine Node.js
FROM node:18-alpine

# Imposta la directory di lavoro
WORKDIR /app

# Copia package.json e package-lock.json
COPY package*.json ./

# Installa le dipendenze
RUN npm install

# Copia il resto dei file
COPY . .

# Espone la porta
EXPOSE 3000

# Comando per avviare l'app
CMD ["npm", "start"]