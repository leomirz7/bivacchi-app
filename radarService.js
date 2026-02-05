// ============================================
// RainViewer Radar Service
// Free precipitation radar overlay for Leaflet maps
// ============================================

const RadarService = {
    // RainViewer API endpoint
    API_URL: 'https://api.rainviewer.com/public/weather-maps.json',
    
    // State
    radarLayers: [],
    currentFrameIndex: 0,
    animationInterval: null,
    isPlaying: false,
    timestamps: [],
    baseLayer: null,
    
    // Settings
    animationSpeed: 500, // ms between frames
    opacity: 0.6,
    colorScheme: 4, // 1-8, see RainViewer docs. 4 = Universal Blue
    smooth: 1,
    snow: 1,
    
    /**
     * Initialize radar overlay on a Leaflet map
     * @param {L.Map} map - Leaflet map instance
     */
    async init(map) {
        this.map = map;
        // Controls are already in HTML, no need to create them dynamically
        
        try {
            await this.loadRadarData();
            console.log('[Radar] Initialized with', this.timestamps.length, 'frames');
            // Don't show radar yet - wait for user to open the panel
            // showRadar() will be called when panel opens
        } catch (error) {
            console.error('[Radar] Failed to initialize:', error);
            throw error;
        }
    },
    
    /**
     * Load radar data from RainViewer API
     */
    async loadRadarData() {
        const response = await fetch(this.API_URL);
        if (!response.ok) throw new Error('Failed to fetch radar data');
        
        const data = await response.json();
        
        // Get past radar frames
        const past = data.radar?.past || [];
        // Get forecast frames (if available)
        const forecast = data.radar?.nowcast || [];
        
        // Combine past + forecast
        this.timestamps = [...past, ...forecast];
        this.host = data.host;
        
        // Clear existing layers
        this.clearLayers();
        
        // Pre-create tile layers for each timestamp
        this.radarLayers = this.timestamps.map(frame => {
            return L.tileLayer(
                `${this.host}${frame.path}/256/{z}/{x}/{y}/${this.colorScheme}/${this.smooth}_${this.snow}.png`,
                {
                    opacity: 0,
                    zIndex: 100
                }
            );
        });
        
        // Show last frame by default
        if (this.radarLayers.length > 0) {
            this.currentFrameIndex = this.radarLayers.length - 1;
        }
    },
    
    // NOTE: UI controls are now defined statically in index.html
    // Event listeners are set up in script.js initRadarControls()
    
    /**
     * Show radar overlay
     */
    async showRadar() {
        if (this.radarLayers.length === 0) {
            try {
                await this.loadRadarData();
            } catch (e) {
                console.error('[Radar] Failed to load data:', e);
                return;
            }
        }
        
        // Update time labels
        this.updateTimeLabels();
        
        // Show current frame
        this.showFrame(this.currentFrameIndex);
    },
    
    /**
     * Hide radar overlay
     */
    hideRadar() {
        this.pause();
        this.clearLayers();
    },
    
    /**
     * Show a specific frame
     */
    showFrame(index) {
        if (index < 0 || index >= this.radarLayers.length) return;
        
        // Hide all layers
        this.radarLayers.forEach((layer, i) => {
            if (this.map.hasLayer(layer)) {
                layer.setOpacity(0);
            }
        });
        
        // Show selected layer
        const layer = this.radarLayers[index];
        if (!this.map.hasLayer(layer)) {
            layer.addTo(this.map);
        }
        layer.setOpacity(this.opacity);
        
        this.currentFrameIndex = index;
        
        // Update UI
        this.updateCurrentTimeLabel();
        this.updateProgress();
    },
    
    /**
     * Go to specific frame
     */
    goToFrame(index) {
        this.showFrame(index);
    },
    
    /**
     * Next frame
     */
    nextFrame() {
        const next = (this.currentFrameIndex + 1) % this.radarLayers.length;
        this.showFrame(next);
    },
    
    /**
     * Previous frame
     */
    previousFrame() {
        const prev = this.currentFrameIndex - 1;
        this.showFrame(prev < 0 ? this.radarLayers.length - 1 : prev);
    },
    
    /**
     * Start animation
     */
    play() {
        if (this.isPlaying) return;
        this.isPlaying = true;
        
        const playBtn = document.getElementById('radar-play-btn');
        if (playBtn) playBtn.textContent = '⏸️';
        
        this.animationInterval = setInterval(() => {
            this.nextFrame();
        }, this.animationSpeed);
    },
    
    /**
     * Pause animation
     */
    pause() {
        this.isPlaying = false;
        
        const playBtn = document.getElementById('radar-play-btn');
        if (playBtn) playBtn.textContent = '▶️';
        
        if (this.animationInterval) {
            clearInterval(this.animationInterval);
            this.animationInterval = null;
        }
    },
    
    /**
     * Update time labels
     */
    updateTimeLabels() {
        if (this.timestamps.length === 0) return;
        
        const startLabel = document.getElementById('radar-time-start');
        const endLabel = document.getElementById('radar-time-end');
        
        if (startLabel) {
            startLabel.textContent = this.formatTime(this.timestamps[0].time);
        }
        if (endLabel) {
            endLabel.textContent = this.formatTime(this.timestamps[this.timestamps.length - 1].time);
        }
        
        this.updateCurrentTimeLabel();
    },
    
    /**
     * Update current time label
     */
    updateCurrentTimeLabel() {
        const currentLabel = document.getElementById('radar-time-current');
        if (currentLabel && this.timestamps[this.currentFrameIndex]) {
            const time = this.timestamps[this.currentFrameIndex].time;
            currentLabel.textContent = this.formatTime(time);
            
            // Show "NOW" or "+X min" for forecast
            const now = Math.floor(Date.now() / 1000);
            const diff = time - now;
            
            if (Math.abs(diff) < 300) { // Within 5 minutes
                currentLabel.textContent += ' (ORA)';
            } else if (diff > 0) {
                const mins = Math.round(diff / 60);
                currentLabel.textContent += ` (+${mins}min)`;
            }
        }
    },
    
    /**
     * Format Unix timestamp to HH:MM
     */
    formatTime(unixTime) {
        const date = new Date(unixTime * 1000);
        return date.toLocaleTimeString('it-IT', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
    },
    
    /**
     * Clear all radar layers from map
     */
    clearLayers() {
        this.radarLayers.forEach(layer => {
            if (this.map && this.map.hasLayer(layer)) {
                this.map.removeLayer(layer);
            }
        });
    },
    
    /**
     * Refresh radar data
     */
    async refresh() {
        this.pause();
        this.clearLayers();
        await this.loadRadarData();
        this.showRadar();
    },
    
    /**
     * Stop animation and hide radar
     */
    stop() {
        this.pause();
        this.hideRadar();
    },
    
    /**
     * Set radar layer opacity
     * @param {number} opacity - Value between 0 and 1
     */
    setOpacity(opacity) {
        this.opacity = Math.max(0, Math.min(1, opacity));
        if (this.radarLayers[this.currentFrameIndex]) {
            this.radarLayers[this.currentFrameIndex].setOpacity(this.opacity);
        }
    },
    
    /**
     * Set color scheme and reload layers
     * @param {number} scheme - RainViewer color scheme (0-8)
     */
    async setColorScheme(scheme) {
        this.colorScheme = scheme;
        // Reload data with new color scheme
        await this.loadRadarData();
        if (this.radarLayers.length > 0) {
            this.showFrame(this.currentFrameIndex);
        }
    },
    
    /**
     * Update progress bar in UI
     */
    updateProgress() {
        const progress = document.getElementById('radar-progress');
        if (progress && this.radarLayers.length > 0) {
            const percent = (this.currentFrameIndex / (this.radarLayers.length - 1)) * 100;
            progress.style.width = `${percent}%`;
        }
    }
};

// Make it globally available
window.RadarService = RadarService;
