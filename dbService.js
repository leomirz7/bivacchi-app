// ============================================
// IndexedDB Service - Offline Storage
// ============================================

const DBService = {
    DB_NAME: 'BivacchiDB',
    DB_VERSION: 1,
    db: null,
    
    // Store names
    STORES: {
        BIVACCHI: 'bivacchi',
        USER_DATA: 'userData',
        SYNC_QUEUE: 'syncQueue',
        GPX_TRACKS: 'gpxTracks'
    },
    
    /**
     * Initialize the database
     */
    async init() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                resolve(this.db);
                return;
            }
            
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            
            request.onerror = (event) => {
                console.error('[DBService] Error opening database:', event.target.error);
                reject(event.target.error);
            };
            
            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('[DBService] Database initialized successfully');
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                console.log('[DBService] Upgrading database...');
                
                // Create bivacchi store (keyed by OSM id)
                if (!db.objectStoreNames.contains(this.STORES.BIVACCHI)) {
                    const bivacchiStore = db.createObjectStore(this.STORES.BIVACCHI, { keyPath: 'id' });
                    bivacchiStore.createIndex('name', 'tags.name', { unique: false });
                    bivacchiStore.createIndex('altitude', 'tags.ele', { unique: false });
                }
                
                // Create user data store
                if (!db.objectStoreNames.contains(this.STORES.USER_DATA)) {
                    db.createObjectStore(this.STORES.USER_DATA, { keyPath: 'key' });
                }
                
                // Create sync queue store
                if (!db.objectStoreNames.contains(this.STORES.SYNC_QUEUE)) {
                    const syncStore = db.createObjectStore(this.STORES.SYNC_QUEUE, { keyPath: 'id', autoIncrement: true });
                    syncStore.createIndex('timestamp', 'timestamp', { unique: false });
                    syncStore.createIndex('type', 'type', { unique: false });
                }
                
                // Create GPX tracks store
                if (!db.objectStoreNames.contains(this.STORES.GPX_TRACKS)) {
                    const gpxStore = db.createObjectStore(this.STORES.GPX_TRACKS, { keyPath: 'id', autoIncrement: true });
                    gpxStore.createIndex('name', 'name', { unique: false });
                    gpxStore.createIndex('savedAt', 'savedAt', { unique: false });
                }
            };
        });
    },
    
    /**
     * Generic transaction helper
     */
    async transaction(storeName, mode, callback) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            
            transaction.onerror = (event) => reject(event.target.error);
            
            const result = callback(store);
            
            if (result && result.onsuccess !== undefined) {
                result.onsuccess = (event) => resolve(event.target.result);
                result.onerror = (event) => reject(event.target.error);
            } else {
                transaction.oncomplete = () => resolve(result);
            }
        });
    },
    
    // ==================== BIVACCHI OPERATIONS ====================
    
    /**
     * Save all bivacchi to IndexedDB
     */
    async saveBivacchi(bivacchi) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(this.STORES.BIVACCHI, 'readwrite');
            const store = transaction.objectStore(this.STORES.BIVACCHI);
            
            // Clear existing data
            store.clear();
            
            // Add all bivacchi
            bivacchi.forEach(biv => {
                store.put(biv);
            });
            
            transaction.oncomplete = () => {
                console.log(`[DBService] Saved ${bivacchi.length} bivacchi to IndexedDB`);
                resolve(true);
            };
            
            transaction.onerror = (event) => {
                console.error('[DBService] Error saving bivacchi:', event.target.error);
                reject(event.target.error);
            };
        });
    },
    
    /**
     * Get all bivacchi from IndexedDB
     */
    async getBivacchi() {
        return this.transaction(this.STORES.BIVACCHI, 'readonly', (store) => {
            return store.getAll();
        });
    },
    
    /**
     * Get a single bivacco by ID
     */
    async getBivaccoById(id) {
        return this.transaction(this.STORES.BIVACCHI, 'readonly', (store) => {
            return store.get(id);
        });
    },
    
    /**
     * Update a single bivacco
     */
    async updateBivacco(bivacco) {
        return this.transaction(this.STORES.BIVACCHI, 'readwrite', (store) => {
            return store.put(bivacco);
        });
    },
    
    // ==================== USER DATA OPERATIONS ====================
    
    /**
     * Save user data
     */
    async saveUserData(key, value) {
        return this.transaction(this.STORES.USER_DATA, 'readwrite', (store) => {
            return store.put({ key, value, updatedAt: Date.now() });
        });
    },
    
    /**
     * Get user data
     */
    async getUserData(key) {
        const result = await this.transaction(this.STORES.USER_DATA, 'readonly', (store) => {
            return store.get(key);
        });
        return result ? result.value : null;
    },
    
    /**
     * Delete user data
     */
    async deleteUserData(key) {
        return this.transaction(this.STORES.USER_DATA, 'readwrite', (store) => {
            return store.delete(key);
        });
    },
    
    // ==================== SYNC QUEUE OPERATIONS ====================
    
    /**
     * Add action to sync queue
     */
    async addToSyncQueue(action) {
        const queueItem = {
            ...action,
            timestamp: Date.now(),
            retryCount: 0
        };
        
        return this.transaction(this.STORES.SYNC_QUEUE, 'readwrite', (store) => {
            return store.add(queueItem);
        });
    },
    
    /**
     * Get all pending sync actions
     */
    async getSyncQueue() {
        return this.transaction(this.STORES.SYNC_QUEUE, 'readonly', (store) => {
            return store.getAll();
        });
    },
    
    /**
     * Remove action from sync queue
     */
    async removeFromSyncQueue(id) {
        return this.transaction(this.STORES.SYNC_QUEUE, 'readwrite', (store) => {
            return store.delete(id);
        });
    },
    
    /**
     * Clear entire sync queue
     */
    async clearSyncQueue() {
        return this.transaction(this.STORES.SYNC_QUEUE, 'readwrite', (store) => {
            return store.clear();
        });
    },
    
    /**
     * Update retry count for a sync action
     */
    async updateSyncRetry(id) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(this.STORES.SYNC_QUEUE, 'readwrite');
            const store = transaction.objectStore(this.STORES.SYNC_QUEUE);
            
            const getRequest = store.get(id);
            getRequest.onsuccess = () => {
                const item = getRequest.result;
                if (item) {
                    item.retryCount = (item.retryCount || 0) + 1;
                    item.lastRetry = Date.now();
                    store.put(item);
                }
            };
            
            transaction.oncomplete = () => resolve(true);
            transaction.onerror = (event) => reject(event.target.error);
        });
    },
    
    // ==================== GPX TRACKS OPERATIONS ====================
    
    /**
     * Save a GPX track
     */
    async saveGPXTrack(track) {
        const trackData = {
            ...track,
            savedAt: Date.now()
        };
        
        return this.transaction(this.STORES.GPX_TRACKS, 'readwrite', (store) => {
            return store.add(trackData);
        });
    },
    
    /**
     * Get all saved GPX tracks
     */
    async getGPXTracks() {
        return this.transaction(this.STORES.GPX_TRACKS, 'readonly', (store) => {
            return store.getAll();
        });
    },
    
    /**
     * Delete a GPX track
     */
    async deleteGPXTrack(id) {
        return this.transaction(this.STORES.GPX_TRACKS, 'readwrite', (store) => {
            return store.delete(id);
        });
    },
    
    // ==================== SYNC MANAGER INTEGRATION ====================
    
    /**
     * Process sync queue (called when online)
     */
    async processSyncQueue(apiBaseUrl) {
        const queue = await this.getSyncQueue();
        if (queue.length === 0) return { success: 0, failed: 0 };
        
        console.log(`[DBService] Processing ${queue.length} sync actions...`);
        let success = 0;
        let failed = 0;
        
        for (const action of queue) {
            try {
                let result = false;
                
                switch (action.type) {
                    case 'COMMENT':
                        result = await this.syncComment(action, apiBaseUrl);
                        break;
                    case 'FAVORITE':
                        result = await this.syncFavorite(action, apiBaseUrl);
                        break;
                    case 'ADDRESS':
                        result = await this.syncAddress(action, apiBaseUrl);
                        break;
                }
                
                if (result) {
                    await this.removeFromSyncQueue(action.id);
                    success++;
                } else {
                    await this.updateSyncRetry(action.id);
                    failed++;
                }
            } catch (error) {
                console.error(`[DBService] Sync failed for action ${action.id}:`, error);
                await this.updateSyncRetry(action.id);
                failed++;
            }
        }
        
        console.log(`[DBService] Sync complete: ${success} success, ${failed} failed`);
        return { success, failed };
    },
    
    async syncComment(action, apiBaseUrl) {
        const res = await fetch(`${apiBaseUrl}/api/bivacchi/${action.bivaccoId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ text: action.text })
        });
        return res.ok;
    },
    
    async syncFavorite(action, apiBaseUrl) {
        const res = await fetch(`${apiBaseUrl}/api/favorites/${action.bivaccoId}`, {
            method: 'POST',
            credentials: 'include'
        });
        return res.ok;
    },
    
    async syncAddress(action, apiBaseUrl) {
        const res = await fetch(`${apiBaseUrl}/api/address`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(action.address)
        });
        return res.ok;
    },
    
    // ==================== UTILITY METHODS ====================
    
    /**
     * Get database storage estimate
     */
    async getStorageInfo() {
        if ('storage' in navigator && 'estimate' in navigator.storage) {
            const estimate = await navigator.storage.estimate();
            return {
                usage: estimate.usage,
                quota: estimate.quota,
                usedPercent: ((estimate.usage / estimate.quota) * 100).toFixed(2)
            };
        }
        return null;
    },
    
    /**
     * Clear all data (for logout or reset)
     */
    async clearAll() {
        await this.init();
        const stores = Object.values(this.STORES);
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(stores, 'readwrite');
            
            stores.forEach(storeName => {
                transaction.objectStore(storeName).clear();
            });
            
            transaction.oncomplete = () => {
                console.log('[DBService] All data cleared');
                resolve(true);
            };
            transaction.onerror = (event) => reject(event.target.error);
        });
    }
};

// Make it globally available
window.DBService = DBService;

// Initialize on load
DBService.init().catch(console.error);
