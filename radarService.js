// ============================================
// RainViewer Radar Service — smooth pre-loaded animation
// ============================================

const RadarService = {
    API_URL: 'https://api.rainviewer.com/public/weather-maps.json',

    // State
    map: null,
    radarLayers: [],       // one L.tileLayer per frame, all kept on map at opacity 0
    timestamps: [],        // raw API frame objects
    host: '',
    currentFrameIndex: -1,
    animationInterval: null,
    isPlaying: false,
    _active: false,        // whether radar is currently shown to the user

    // Settings
    animationSpeed: 600,   // ms between frames
    opacity: 0.7,
    colorScheme: 4,        // 4 = TWC (good contrast on dark map)
    smooth: 1,
    snow: 1,

    // ── Init: fetch data, pre-add all layers to map at opacity 0 ──
    async init(map) {
        this.map = map;
        await this._fetchAndBuild();
        console.log('[Radar] Initialized with', this.timestamps.length, 'frames');
    },

    async _fetchAndBuild() {
        const res = await fetch(this.API_URL);
        if (!res.ok) throw new Error('RainViewer API error');
        const data = await res.json();

        this.host = data.host;
        const past     = data.radar?.past     || [];
        const nowcast  = data.radar?.nowcast  || [];
        const frames   = [...past, ...nowcast];

        // Remove old layers from map without destroying the array reference yet
        this._removeAllFromMap();
        this.radarLayers = [];
        this.timestamps  = [];

        frames.forEach(frame => {
            const url = `${this.host}${frame.path}/256/{z}/{x}/{y}/${this.colorScheme}/${this.smooth}_${this.snow}.png`;
            const layer = L.tileLayer(url, {
                opacity:     0,
                zIndex:      200,
                tileSize:    256,
                // Keep tiles in memory even at opacity 0 so they're ready instantly
                keepBuffer:  4,
            });
            // Pre-add to map immediately so tiles start downloading in background
            layer.addTo(this.map);
            this.radarLayers.push(layer);
            this.timestamps.push(frame);
        });

        // Default to the last past frame (most recent observation)
        const lastPastIdx = past.length > 0 ? past.length - 1 : 0;
        this.currentFrameIndex = lastPastIdx;
    },

    // ── Show the radar (called when user toggles it on) ──
    async showRadar() {
        this._active = true;

        if (this.radarLayers.length === 0) {
            try { await this._fetchAndBuild(); }
            catch (e) { console.error('[Radar] Load failed:', e); return; }
        }

        this.updateTimeLabels();
        this._applyFrame(this.currentFrameIndex);
        // Auto-play animation
        this.play();
    },

    // ── Hide the radar (keep layers on map at opacity 0 to preserve cache) ──
    hideRadar() {
        this._active = false;
        this.pause();
        // Just zero-out all layers – don't remove them so tiles stay cached
        this.radarLayers.forEach(l => l.setOpacity(0));
    },

    // ── Core: switch to frame[index], fade out previous ──
    _applyFrame(index) {
        if (index < 0 || index >= this.radarLayers.length) return;

        const prev = this.currentFrameIndex;
        this.currentFrameIndex = index;

        // Fade out previous frame
        if (prev >= 0 && prev !== index && this.radarLayers[prev]) {
            this.radarLayers[prev].setOpacity(0);
        }

        // Fade in current frame
        this.radarLayers[index].setOpacity(this.opacity);

        this._updateUI();
    },

    showFrame(index)  { this._applyFrame(index); },
    goToFrame(index)  { this._applyFrame(index); },

    nextFrame() {
        const next = (this.currentFrameIndex + 1) % this.radarLayers.length;
        this._applyFrame(next);
    },

    previousFrame() {
        const len  = this.radarLayers.length;
        const prev = (this.currentFrameIndex - 1 + len) % len;
        this._applyFrame(prev);
    },

    // ── Animation ──
    play() {
        if (this.isPlaying || this.radarLayers.length === 0) return;
        this.isPlaying = true;
        const playBtn = document.getElementById('radar-play-btn');
        if (playBtn) playBtn.textContent = '⏸️';

        this.animationInterval = setInterval(() => this.nextFrame(), this.animationSpeed);
    },

    pause() {
        if (!this.isPlaying) return;
        this.isPlaying = false;
        const playBtn = document.getElementById('radar-play-btn');
        if (playBtn) playBtn.textContent = '▶️';
        clearInterval(this.animationInterval);
        this.animationInterval = null;
    },

    stop() {
        this.pause();
        this.hideRadar();
    },

    // ── Settings ──
    setOpacity(val) {
        this.opacity = Math.max(0, Math.min(1, val));
        // Only update the currently-visible frame
        if (this._active && this.radarLayers[this.currentFrameIndex]) {
            this.radarLayers[this.currentFrameIndex].setOpacity(this.opacity);
        }
    },

    async setColorScheme(scheme) {
        this.colorScheme = scheme;
        const wasPlaying = this.isPlaying;
        this.pause();
        this._removeAllFromMap();
        await this._fetchAndBuild();
        if (this._active) {
            this.updateTimeLabels();
            this._applyFrame(this.currentFrameIndex);
            if (wasPlaying) this.play();
        }
    },

    async refresh() {
        const wasPlaying = this.isPlaying;
        this.pause();
        this._removeAllFromMap();
        await this._fetchAndBuild();
        if (this._active) {
            this.updateTimeLabels();
            this._applyFrame(this.currentFrameIndex);
            if (wasPlaying) this.play();
        }
    },

    // ── UI helpers ──
    _updateUI() {
        this.updateCurrentTimeLabel();
        this.updateProgress();
    },

    updateTimeLabels() {
        if (this.timestamps.length === 0) return;
        const s = document.getElementById('radar-time-start');
        const e = document.getElementById('radar-time-end');
        if (s) s.textContent = this.formatTime(this.timestamps[0].time);
        if (e) e.textContent = this.formatTime(this.timestamps[this.timestamps.length - 1].time);
        this.updateCurrentTimeLabel();
    },

    updateCurrentTimeLabel() {
        const el = document.getElementById('radar-time-current');
        if (!el || !this.timestamps[this.currentFrameIndex]) return;
        const time = this.timestamps[this.currentFrameIndex].time;
        let label = this.formatTime(time);
        const now  = Math.floor(Date.now() / 1000);
        const diff = time - now;
        if (Math.abs(diff) < 300)      label += ' (ORA)';
        else if (diff > 0)             label += ` (+${Math.round(diff / 60)}min)`;
        el.textContent = label;
    },

    updateProgress() {
        const bar = document.getElementById('radar-progress');
        if (bar && this.radarLayers.length > 1) {
            bar.style.width = `${(this.currentFrameIndex / (this.radarLayers.length - 1)) * 100}%`;
        }
    },

    formatTime(unixTime) {
        return new Date(unixTime * 1000).toLocaleTimeString('it-IT', {
            hour: '2-digit', minute: '2-digit'
        });
    },

    // ── Internal: remove all layers from map (but keep radarLayers array) ──
    _removeAllFromMap() {
        this.radarLayers.forEach(l => {
            if (this.map?.hasLayer(l)) this.map.removeLayer(l);
        });
    },

    // Legacy alias kept for any external callers
    clearLayers() { this._removeAllFromMap(); }
};

window.RadarService = RadarService;
