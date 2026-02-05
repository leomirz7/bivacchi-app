// ============================================
// GPX Service - Parse GPX files and calculate statistics
// ============================================

const GPXService = {
    // Current loaded tracks
    tracks: [],
    trackLayers: [],
    elevationData: [],
    currentStats: null,
    currentTrackName: '',
    
    // Track colors for multiple tracks
    TRACK_COLORS: ['#ea580c', '#d946ef', '#3b82f6', '#22c55e', '#f59e0b'],
    
    /**
     * Parse a GPX file and extract track data
     * @param {string} gpxContent - Raw GPX XML content
     * @returns {Object} Parsed track data with points and metadata
     */
    parseGPX(gpxContent) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(gpxContent, 'application/xml');
        
        // Check for parsing errors
        const parseError = doc.querySelector('parsererror');
        if (parseError) {
            throw new Error('File GPX non valido');
        }
        
        const tracks = [];
        
        // Parse <trk> elements (tracks)
        const trkElements = doc.querySelectorAll('trk');
        trkElements.forEach((trk, trkIndex) => {
            const trackName = trk.querySelector('name')?.textContent || `Traccia ${trkIndex + 1}`;
            const segments = [];
            
            // Parse <trkseg> elements (track segments)
            const trksegElements = trk.querySelectorAll('trkseg');
            trksegElements.forEach(seg => {
                const points = [];
                const trkpts = seg.querySelectorAll('trkpt');
                
                trkpts.forEach(pt => {
                    const lat = parseFloat(pt.getAttribute('lat'));
                    const lon = parseFloat(pt.getAttribute('lon'));
                    const ele = parseFloat(pt.querySelector('ele')?.textContent) || null;
                    const time = pt.querySelector('time')?.textContent || null;
                    
                    if (!isNaN(lat) && !isNaN(lon)) {
                        points.push({ lat, lon, ele, time });
                    }
                });
                
                if (points.length > 0) {
                    segments.push(points);
                }
            });
            
            if (segments.length > 0) {
                tracks.push({
                    name: trackName,
                    segments,
                    color: this.TRACK_COLORS[trkIndex % this.TRACK_COLORS.length]
                });
            }
        });
        
        // Also parse <rte> elements (routes) as tracks
        const rteElements = doc.querySelectorAll('rte');
        rteElements.forEach((rte, rteIndex) => {
            const routeName = rte.querySelector('name')?.textContent || `Percorso ${rteIndex + 1}`;
            const points = [];
            
            const rtepts = rte.querySelectorAll('rtept');
            rtepts.forEach(pt => {
                const lat = parseFloat(pt.getAttribute('lat'));
                const lon = parseFloat(pt.getAttribute('lon'));
                const ele = parseFloat(pt.querySelector('ele')?.textContent) || null;
                
                if (!isNaN(lat) && !isNaN(lon)) {
                    points.push({ lat, lon, ele, time: null });
                }
            });
            
            if (points.length > 0) {
                tracks.push({
                    name: routeName,
                    segments: [points],
                    color: this.TRACK_COLORS[(trkElements.length + rteIndex) % this.TRACK_COLORS.length]
                });
            }
        });
        
        return tracks;
    },
    
    /**
     * Calculate distance between two points using Haversine formula
     */
    haversineDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth radius in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) * Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    },
    
    /**
     * Calculate comprehensive track statistics
     */
    calculateStats(tracks) {
        let totalDistance = 0;
        let totalElevationGain = 0;
        let totalElevationLoss = 0;
        let minElevation = Infinity;
        let maxElevation = -Infinity;
        let allPoints = [];
        let maxGrade = 0;
        
        tracks.forEach(track => {
            track.segments.forEach(segment => {
                for (let i = 0; i < segment.length; i++) {
                    const point = segment[i];
                    allPoints.push(point);
                    
                    if (point.ele !== null) {
                        minElevation = Math.min(minElevation, point.ele);
                        maxElevation = Math.max(maxElevation, point.ele);
                    }
                    
                    if (i > 0) {
                        const prevPoint = segment[i - 1];
                        const dist = this.haversineDistance(
                            prevPoint.lat, prevPoint.lon,
                            point.lat, point.lon
                        );
                        totalDistance += dist;
                        
                        if (point.ele !== null && prevPoint.ele !== null) {
                            const eleDiff = point.ele - prevPoint.ele;
                            if (eleDiff > 0) {
                                totalElevationGain += eleDiff;
                            } else {
                                totalElevationLoss += Math.abs(eleDiff);
                            }
                            
                            // Calculate grade (slope percentage)
                            if (dist > 0.001) { // Avoid division by very small numbers
                                const grade = Math.abs(eleDiff / (dist * 1000)) * 100;
                                maxGrade = Math.max(maxGrade, grade);
                            }
                        }
                    }
                }
            });
        });
        
        // Estimate hiking time using Naismith's rule with Tranter's corrections
        // Base: 5 km/h on flat, +1 hour per 600m of ascent
        const horizontalTimeHours = totalDistance / 5;
        const ascentTimeHours = totalElevationGain / 600;
        const estimatedTimeHours = horizontalTimeHours + ascentTimeHours;
        
        // Calculate VAM (Velocità Ascensionale Media) if we have time data
        let vam = null;
        if (allPoints.length >= 2 && allPoints[0].time && allPoints[allPoints.length - 1].time) {
            const startTime = new Date(allPoints[0].time);
            const endTime = new Date(allPoints[allPoints.length - 1].time);
            const durationHours = (endTime - startTime) / (1000 * 60 * 60);
            if (durationHours > 0 && totalElevationGain > 0) {
                vam = Math.round(totalElevationGain / durationHours);
            }
        }
        
        // Calculate average speed if time data available
        let avgSpeed = null;
        let movingTime = null;
        if (allPoints.length >= 2 && allPoints[0].time && allPoints[allPoints.length - 1].time) {
            const startTime = new Date(allPoints[0].time);
            const endTime = new Date(allPoints[allPoints.length - 1].time);
            const durationHours = (endTime - startTime) / (1000 * 60 * 60);
            movingTime = durationHours;
            if (durationHours > 0) {
                avgSpeed = totalDistance / durationHours;
            }
        }
        
        return {
            distance: totalDistance,
            elevationGain: totalElevationGain,
            elevationLoss: totalElevationLoss,
            minElevation: minElevation === Infinity ? null : minElevation,
            maxElevation: maxElevation === -Infinity ? null : maxElevation,
            estimatedTime: estimatedTimeHours,
            maxGrade: maxGrade,
            vam: vam,
            avgSpeed: avgSpeed,
            movingTime: movingTime,
            pointCount: allPoints.length
        };
    },
    
    /**
     * Format time in hours to HH:MM format
     */
    formatTime(hours) {
        const h = Math.floor(hours);
        const m = Math.round((hours - h) * 60);
        return `${h}h ${m.toString().padStart(2, '0')}m`;
    },
    
    /**
     * Get all points for elevation profile
     */
    getElevationProfile(tracks) {
        const profile = [];
        let cumulativeDistance = 0;
        
        tracks.forEach(track => {
            track.segments.forEach(segment => {
                for (let i = 0; i < segment.length; i++) {
                    const point = segment[i];
                    
                    if (i > 0) {
                        const prevPoint = segment[i - 1];
                        cumulativeDistance += this.haversineDistance(
                            prevPoint.lat, prevPoint.lon,
                            point.lat, point.lon
                        );
                    }
                    
                    profile.push({
                        distance: cumulativeDistance,
                        elevation: point.ele,
                        lat: point.lat,
                        lon: point.lon
                    });
                }
            });
        });
        
        return profile;
    },
    
    /**
     * Display track on the map
     * @param {Object} map - Leaflet map instance
     * @param {Array} tracks - Parsed track data
     */
    displayOnMap(map, tracks) {
        // Remove existing track layers
        this.clearTracks(map);
        
        const allBounds = [];
        
        tracks.forEach((track, index) => {
            track.segments.forEach(segment => {
                const latlngs = segment.map(p => [p.lat, p.lon]);
                
                if (latlngs.length > 0) {
                    // Create polyline with glow effect
                    const glowLine = L.polyline(latlngs, {
                        color: track.color,
                        weight: 8,
                        opacity: 0.3,
                        lineCap: 'round',
                        lineJoin: 'round'
                    }).addTo(map);
                    
                    const mainLine = L.polyline(latlngs, {
                        color: track.color,
                        weight: 4,
                        opacity: 0.9,
                        lineCap: 'round',
                        lineJoin: 'round'
                    }).addTo(map);
                    
                    // Add click listener to reopen stats panel
                    mainLine.on('click', () => {
                        if (this.currentStats) {
                            this.showStatsPanel(this.currentStats, this.currentTrackName);
                        }
                    });
                    
                    this.trackLayers.push(glowLine, mainLine);
                    allBounds.push(...latlngs);
                    
                    // Add start marker
                    const startMarker = L.marker(latlngs[0], {
                        icon: L.divIcon({
                            className: 'gpx-marker gpx-start',
                            html: `<div style="background: #22c55e; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">S</div>`,
                            iconSize: [24, 24],
                            iconAnchor: [12, 12]
                        })
                    }).addTo(map);
                    
                    // Add end marker
                    const endMarker = L.marker(latlngs[latlngs.length - 1], {
                        icon: L.divIcon({
                            className: 'gpx-marker gpx-end',
                            html: `<div style="background: #ef4444; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">E</div>`,
                            iconSize: [24, 24],
                            iconAnchor: [12, 12]
                        })
                    }).addTo(map);
                    
                    this.trackLayers.push(startMarker, endMarker);
                }
            });
        });
        
        // Fit map to track bounds
        if (allBounds.length > 0) {
            map.fitBounds(allBounds, { padding: [50, 50] });
        }
        
        this.tracks = tracks;
    },
    
    /**
     * Clear all track layers from map
     */
    clearTracks(map) {
        this.trackLayers.forEach(layer => {
            if (map.hasLayer(layer)) {
                map.removeLayer(layer);
            }
        });
        this.trackLayers = [];
        this.tracks = [];
    },
    
    /**
     * Generate HTML for stats panel
     */
    generateStatsHTML(stats, trackName = 'Traccia') {
        return `
            <div class="gpx-stats-panel">
                <div class="gpx-stats-header">
                    <h4>📍 ${this.escapeHtml(trackName)}</h4>
                    <button class="gpx-close-btn" onclick="GPXService.closeStatsPanel()">×</button>
                </div>
                <div class="stat-grid">
                    <div class="stat-box">
                        <div class="stat-label">Distanza</div>
                        <div class="stat-value accent">${stats.distance.toFixed(2)} km</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">Tempo stimato</div>
                        <div class="stat-value">${this.formatTime(stats.estimatedTime)}</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">Dislivello +</div>
                        <div class="stat-value" style="color: #22c55e;">↑ ${Math.round(stats.elevationGain)} m</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">Dislivello -</div>
                        <div class="stat-value" style="color: #ef4444;">↓ ${Math.round(stats.elevationLoss)} m</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">Quota min</div>
                        <div class="stat-value">${stats.minElevation ? Math.round(stats.minElevation) : '-'} m</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-label">Quota max</div>
                        <div class="stat-value">${stats.maxElevation ? Math.round(stats.maxElevation) : '-'} m</div>
                    </div>
                    ${stats.maxGrade > 0 ? `
                    <div class="stat-box">
                        <div class="stat-label">Pendenza max</div>
                        <div class="stat-value">${stats.maxGrade.toFixed(1)}%</div>
                    </div>
                    ` : ''}
                    ${stats.vam ? `
                    <div class="stat-box">
                        <div class="stat-label">VAM</div>
                        <div class="stat-value">${stats.vam} m/h</div>
                    </div>
                    ` : ''}
                </div>
                <div id="elevation-profile-container"></div>
                <button class="form-btn mt-4" onclick="GPXService.clearCurrentTrack()">🗑️ Rimuovi Traccia</button>
            </div>
        `;
    },
    
    /**
     * Show stats panel
     */
    showStatsPanel(stats, trackName) {
        // Remove existing panel
        this.closeStatsPanel();
        
        // Save current stats for reopening
        this.currentStats = stats;
        this.currentTrackName = trackName;
        
        console.log('[GPX] Showing stats panel for:', trackName);
        
        const panel = document.createElement('div');
        panel.id = 'gpx-stats-panel';
        panel.innerHTML = this.generateStatsHTML(stats, trackName);
        document.body.appendChild(panel);
        
        console.log('[GPX] Panel created and added to DOM');
        
        // Show info button
        this.updateInfoButton(true);
        
        // Generate elevation profile
        setTimeout(() => {
            this.renderElevationProfile();
        }, 100);
    },
    
    /**
     * Close stats panel
     */
    closeStatsPanel() {
        const panel = document.getElementById('gpx-stats-panel');
        if (panel) {
            panel.remove();
        }
    },
    
    /**
     * Toggle stats panel visibility
     */
    toggleStatsPanel() {
        const panel = document.getElementById('gpx-stats-panel');
        if (panel) {
            // Panel exists, close it
            this.closeStatsPanel();
        } else if (this.currentStats) {
            // Panel doesn't exist but we have stats, show it
            this.showStatsPanel(this.currentStats, this.currentTrackName);
        }
    },
    
    /**
     * Clear current track and close panel
     */
    clearCurrentTrack() {
        if (typeof map !== 'undefined') {
            this.clearTracks(map);
        }
        this.closeStatsPanel();
        this.elevationData = [];
        this.currentStats = null;
        this.currentTrackName = '';
        this.tracks = [];
        this.updateInfoButton(false);
    },
    
    /**
     * Update visibility of info button
     */
    updateInfoButton(show) {
        const infoBtn = document.getElementById('gpx-info-btn');
        if (infoBtn) {
            infoBtn.style.display = show ? 'inline-flex' : 'none';
        }
    },
    
    /**
     * Render SVG elevation profile
     */
    renderElevationProfile() {
        const container = document.getElementById('elevation-profile-container');
        if (!container || this.elevationData.length === 0) return;
        
        const width = container.clientWidth || 300;
        const height = 120;
        const padding = { top: 10, right: 10, bottom: 25, left: 40 };
        
        const data = this.elevationData.filter(p => p.elevation !== null);
        if (data.length < 2) return;
        
        const maxDist = Math.max(...data.map(p => p.distance));
        const minEle = Math.min(...data.map(p => p.elevation));
        const maxEle = Math.max(...data.map(p => p.elevation));
        const eleRange = maxEle - minEle || 1;
        
        const chartWidth = width - padding.left - padding.right;
        const chartHeight = height - padding.top - padding.bottom;
        
        const scaleX = (dist) => padding.left + (dist / maxDist) * chartWidth;
        const scaleY = (ele) => padding.top + chartHeight - ((ele - minEle) / eleRange) * chartHeight;
        
        // Build path
        let pathD = `M ${scaleX(data[0].distance)} ${scaleY(data[0].elevation)}`;
        for (let i = 1; i < data.length; i++) {
            pathD += ` L ${scaleX(data[i].distance)} ${scaleY(data[i].elevation)}`;
        }
        
        // Build area fill
        let areaD = pathD + ` L ${scaleX(data[data.length - 1].distance)} ${scaleY(minEle)} L ${scaleX(data[0].distance)} ${scaleY(minEle)} Z`;
        
        const svg = `
            <svg width="${width}" height="${height}" class="elevation-chart">
                <defs>
                    <linearGradient id="eleGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" style="stop-color:#ea580c;stop-opacity:0.6" />
                        <stop offset="100%" style="stop-color:#ea580c;stop-opacity:0.1" />
                    </linearGradient>
                </defs>
                <!-- Grid lines -->
                <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + chartHeight}" stroke="#3f3f46" stroke-width="1"/>
                <line x1="${padding.left}" y1="${padding.top + chartHeight}" x2="${width - padding.right}" y2="${padding.top + chartHeight}" stroke="#3f3f46" stroke-width="1"/>
                
                <!-- Area fill -->
                <path d="${areaD}" fill="url(#eleGradient)" />
                
                <!-- Line -->
                <path d="${pathD}" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                
                <!-- Y-axis labels -->
                <text x="${padding.left - 5}" y="${padding.top + 5}" fill="#a1a1aa" font-size="10" text-anchor="end">${Math.round(maxEle)}m</text>
                <text x="${padding.left - 5}" y="${padding.top + chartHeight}" fill="#a1a1aa" font-size="10" text-anchor="end">${Math.round(minEle)}m</text>
                
                <!-- X-axis labels -->
                <text x="${padding.left}" y="${height - 5}" fill="#a1a1aa" font-size="10" text-anchor="start">0</text>
                <text x="${width - padding.right}" y="${height - 5}" fill="#a1a1aa" font-size="10" text-anchor="end">${maxDist.toFixed(1)}km</text>
            </svg>
        `;
        
        container.innerHTML = svg;
    },
    
    /**
     * Escape HTML to prevent XSS
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },
    
    /**
     * Handle file input
     */
    handleFileUpload(file, mapInstance) {
        if (!file) return;
        
        if (!file.name.toLowerCase().endsWith('.gpx')) {
            alert('Per favore seleziona un file GPX valido');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const content = e.target.result;
                const tracks = this.parseGPX(content);
                
                if (tracks.length === 0) {
                    alert('Nessuna traccia trovata nel file GPX');
                    return;
                }
                
                this.displayOnMap(mapInstance, tracks);
                const stats = this.calculateStats(tracks);
                this.elevationData = this.getElevationProfile(tracks);
                
                const trackName = tracks.length === 1 
                    ? tracks[0].name 
                    : `${tracks.length} tracce`;
                
                this.showStatsPanel(stats, trackName);
                
            } catch (error) {
                console.error('Errore parsing GPX:', error);
                alert('Errore nel caricamento del file GPX: ' + error.message);
            }
        };
        
        reader.onerror = () => {
            alert('Errore nella lettura del file');
        };
        
        reader.readAsText(file);
    }
};

// Make it globally available
window.GPXService = GPXService;
