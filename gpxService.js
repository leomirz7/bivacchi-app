// ============================================
// GPX Service - MountPro-style interactive track panel
// ============================================

const GPXService = {
    // State
    tracks: [],           // Array of LoadedTrack objects
    trackLayers: [],      // Leaflet layers for cleanup
    hoverMarker: null,    // Blue dot on map synced with chart scrub
    mapRef: null,         // Leaflet map reference
    isExpanded: false,     // Track panel expanded state
    _touchStartY: null,    // For swipe gestures

    TRACK_COLORS: ['#ea580c', '#d946ef'],
    MAX_TRACKS: 2,

    // ── Haversine distance (km) ──
    haversine(lat1, lon1, lat2, lon2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },

    // ── Format duration (seconds → "Xh Ym") ──
    formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
    },

    // ── Parse GPX file → LoadedTrack object ──
    parseAndCreateTrack(gpxText, fileName) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(gpxText, 'text/xml');
        const trkpts = doc.getElementsByTagName('trkpt');

        if (trkpts.length === 0) {
            // Try <rtept> as fallback
            const rtepts = doc.getElementsByTagName('rtept');
            if (rtepts.length === 0) throw new Error('Nessuna traccia valida trovata.');
            return this._buildTrack(rtepts, fileName, doc);
        }
        return this._buildTrack(trkpts, fileName, doc);
    },

    _buildTrack(trkpts, fileName, doc) {
        const points = [];
        const latlngs = [];
        let totalDist = 0, gain = 0, loss = 0;
        let minEle = Infinity, maxEle = -Infinity, maxGrade = 0;
        let totalTime = 0, hasTime = false;
        let ascentTimeSeconds = 0;

        // Get track name from GPX metadata or filename
        const nameEl = doc.querySelector('trk > name') || doc.querySelector('rte > name');
        const trackName = nameEl?.textContent || fileName.replace(/\.gpx$/i, '');

        for (let i = 0; i < trkpts.length; i++) {
            const lat = parseFloat(trkpts[i].getAttribute('lat') || '0');
            const lng = parseFloat(trkpts[i].getAttribute('lon') || '0');
            const eleNode = trkpts[i].getElementsByTagName('ele')[0];
            const ele = eleNode ? parseFloat(eleNode.textContent || '0') : 0;
            const timeNode = trkpts[i].getElementsByTagName('time')[0];
            let timeTs = undefined;
            if (timeNode) { hasTime = true; timeTs = new Date(timeNode.textContent || '').getTime(); }

            latlngs.push([lat, lng]);
            let distStep = 0;

            if (i > 0) {
                const prev = points[i - 1];
                distStep = this.haversine(prev.lat, prev.lng, lat, lng);
                totalDist += distStep;
                const eleDiff = ele - prev.ele;
                if (eleDiff > 0) {
                    gain += eleDiff;
                    if (hasTime && timeTs && prev.time) {
                        const dt = (timeTs - prev.time) / 1000;
                        if (dt > 0 && dt < 120) ascentTimeSeconds += dt;
                    }
                } else {
                    loss += Math.abs(eleDiff);
                }
                if (distStep > 0.01) {
                    const grade = Math.abs((eleDiff / (distStep * 1000)) * 100);
                    if (grade < 100 && grade > maxGrade) maxGrade = grade;
                }
                if (hasTime && timeTs && prev.time) {
                    totalTime += (timeTs - prev.time) / 1000;
                }
            }

            if (ele < minEle) minEle = ele;
            if (ele > maxEle) maxEle = ele;

            points.push({ lat, lng, ele, dist: totalDist, time: timeTs });
        }

        // Simplify points for chart performance (max ~400 points)
        const step = Math.ceil(points.length / 400);
        const simplifiedPoints = points.filter((_, i) => i % step === 0);

        // Estimate time if not available
        let isEstimated = false;
        if (!hasTime || totalTime === 0) {
            isEstimated = true;
            totalTime = (totalDist / 4) * 3600 + (gain / 600) * 3600;
            ascentTimeSeconds = (gain / 600) * 3600;
        }

        const avgSpeed = totalTime > 0 ? (totalDist / (totalTime / 3600)) : 0;
        let vam = 0;
        if (ascentTimeSeconds > 600 && gain > 50) {
            vam = Math.round(gain / (ascentTimeSeconds / 3600));
        }

        return {
            id: crypto.randomUUID(),
            name: trackName,
            latlngs,
            points: simplifiedPoints,
            stats: {
                totalDistance: totalDist,
                elevationGain: gain,
                elevationLoss: loss,
                minElevation: minEle === Infinity ? 0 : minEle,
                maxElevation: maxEle === -Infinity ? 0 : maxEle,
                totalTimeSeconds: totalTime,
                avgSpeedKmh: avgSpeed,
                maxGrade,
                isEstimatedTime: isEstimated,
                vam: vam > 0 ? vam : undefined
            },
            color: this.TRACK_COLORS[this.tracks.length % this.TRACK_COLORS.length]
        };
    },

    // ── Display track on map ──
    displayTrackOnMap(track) {
        if (!this.mapRef) return;

        // Polyline
        const polyline = L.polyline(track.latlngs, {
            color: track.color,
            weight: 4,
            opacity: 0.9,
            lineJoin: 'round',
            lineCap: 'round'
        }).addTo(this.mapRef);

        polyline.on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            this.openPanel(track.id);
        });

        this.trackLayers.push(polyline);

        // Start marker (play icon)
        const startIcon = L.divIcon({
            className: '',
            html: `<div style="width:28px;height:28px;border-radius:50%;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;background:${track.color}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="white" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
        const startMarker = L.marker(track.latlngs[0], { icon: startIcon, interactive: false }).addTo(this.mapRef);
        this.trackLayers.push(startMarker);

        // End marker (flag icon)
        const endIcon = L.divIcon({
            className: '',
            html: `<div style="width:28px;height:28px;border-radius:50%;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;background:#ef4444">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>
            </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
        const endMarker = L.marker(track.latlngs[track.latlngs.length - 1], { icon: endIcon, interactive: false }).addTo(this.mapRef);
        this.trackLayers.push(endMarker);

        // Direction arrows every ~1km
        let distAccumulator = 0;
        let nextMilestone = 1.0;
        for (let i = 0; i < track.latlngs.length - 1; i++) {
            const p1 = track.latlngs[i], p2 = track.latlngs[i + 1];
            distAccumulator += this.haversine(p1[0], p1[1], p2[0], p2[1]);
            if (distAccumulator >= nextMilestone) {
                const dLon = (p2[1] - p1[1]) * Math.PI / 180;
                const lat1Rad = p1[0] * Math.PI / 180;
                const lat2Rad = p2[0] * Math.PI / 180;
                const y = Math.sin(dLon) * Math.cos(lat2Rad);
                const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
                const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
                const arrowIcon = L.divIcon({
                    className: '',
                    html: `<div style="transform:rotate(${bearing}deg);width:20px;height:20px;display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgba(0,0,0,0.6)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg></div>`,
                    iconSize: [20, 20],
                    iconAnchor: [10, 10]
                });
                L.marker(p1, { icon: arrowIcon, interactive: false }).addTo(this.mapRef);
                nextMilestone += 1.0;
            }
        }

        // Fit bounds with bottom padding for panel
        const poly = L.polyline(track.latlngs);
        this.mapRef.fitBounds(poly.getBounds(), {
            padding: [50, 50],
            paddingBottomRight: [0, window.innerHeight * 0.4]
        });
    },

    // ── Center map on a track ──
    centerOnTrack(track, withOffset = false) {
        if (!this.mapRef) return;
        const poly = L.polyline(track.latlngs);
        const opts = { padding: [50, 50] };
        if (withOffset) opts.paddingBottomRight = [0, window.innerHeight * 0.4];
        this.mapRef.fitBounds(poly.getBounds(), opts);
    },

    // ── Remove a track ──
    removeTrack(trackId) {
        this.tracks = this.tracks.filter(t => t.id !== trackId);
        // Re-assign colors
        this.tracks.forEach((t, i) => t.color = this.TRACK_COLORS[i % this.TRACK_COLORS.length]);
        // Clear and re-render all layers
        this.clearAllLayers();
        this.tracks.forEach(t => this.displayTrackOnMap(t));
        if (this.tracks.length === 0) {
            this.closePanel();
        } else {
            this.renderPanel();
        }
    },

    // ── Clear all track layers from map ──
    clearAllLayers() {
        if (!this.mapRef) return;
        this.trackLayers.forEach(layer => {
            if (this.mapRef.hasLayer(layer)) this.mapRef.removeLayer(layer);
        });
        this.trackLayers = [];
        this.removeHoverMarker();
    },

    // ── Remove blue hover marker ──
    removeHoverMarker() {
        if (this.hoverMarker && this.mapRef) {
            this.mapRef.removeLayer(this.hoverMarker);
            this.hoverMarker = null;
        }
    },

    // ── Set/move blue hover marker on map ──
    setHoverMarker(lat, lng) {
        if (!this.mapRef) return;
        if (!this.hoverMarker) {
            const icon = L.divIcon({
                className: 'gpx-hover-dot',
                html: '<div class="gpx-hover-dot-inner"></div>',
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            });
            this.hoverMarker = L.marker([lat, lng], { icon, zIndexOffset: 2000, interactive: false }).addTo(this.mapRef);
        } else {
            this.hoverMarker.setLatLng([lat, lng]);
        }
    },

    // ── Open the track panel ──
    openPanel(focusTrackId) {
        const tp = document.getElementById('track-panel');
        if (!tp) return;
        if (focusTrackId) tp.dataset.focusedTrack = focusTrackId;
        this.isExpanded = false;
        tp.classList.remove('tp-expanded');
        tp.classList.add('tp-open');
        this.renderPanel();
        // Show GPX proximity section
        const gpxSec = document.getElementById('gpx-proximity-section');
        if (gpxSec) gpxSec.style.display = '';
        // Show "Sul Percorso" badge
        this.updateTrackBadges();
    },

    // ── Close the track panel ──
    closePanel() {
        const tp = document.getElementById('track-panel');
        if (tp) {
            tp.classList.remove('tp-open', 'tp-expanded');
            delete tp.dataset.focusedTrack;
        }
        this.removeHoverMarker();
        this.updateTrackBadges();
    },

    // ── Clear everything ──
    clearAll() {
        this.clearAllLayers();
        this.tracks = [];
        this.closePanel();
        const gpxSec = document.getElementById('gpx-proximity-section');
        if (gpxSec) gpxSec.style.display = 'none';
        this.updateTrackBadges();
    },

    // ── Update "Sul Percorso" filter badge in header ──
    updateTrackBadges() {
        // Handled by script.js updateFilterBadges()
        if (typeof updateFilterBadges === 'function') updateFilterBadges();
    },

    // ── Get the focused track ──
    getFocusedTrack() {
        const tp = document.getElementById('track-panel');
        const focusId = tp?.dataset.focusedTrack;
        if (focusId) return this.tracks.find(t => t.id === focusId) || this.tracks[0];
        return this.tracks[0] || null;
    },

    // ── Generate SVG chart path ──
    _chartPath(points, w, h, minEle, maxEle, totalDist) {
        if (points.length < 2) return '';
        const eleRange = maxEle - minEle || 1;
        return points.map(p => {
            const x = (p.dist / totalDist) * w;
            const y = h - ((p.ele - minEle) / eleRange) * h;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
    },

    // ── RENDER THE ENTIRE PANEL ──
    renderPanel() {
        const tp = document.getElementById('track-panel');
        const tpBody = document.getElementById('track-panel-body');
        const tpNameLabel = document.getElementById('track-name-label');
        const tpAddBtn = document.getElementById('btn-add-gpx');
        if (!tp || !tpBody) return;

        const track = this.getFocusedTrack();
        if (!track) return;

        // Header: name + add button
        if (tpNameLabel) {
            if (this.tracks.length > 1) {
                // Show tab-style selector
                tpNameLabel.innerHTML = this.tracks.map(t =>
                    `<button class="tp-tab ${t.id === track.id ? 'active' : ''}" data-track-id="${t.id}">
                        <span class="tp-tab-dot" style="background:${t.color}"></span>
                        <span class="tp-tab-name">${this.escapeHtml(t.name)}</span>
                    </button>`
                ).join('');
            } else {
                tpNameLabel.textContent = track.name;
            }
        }

        // Show/hide + button
        if (tpAddBtn) tpAddBtn.style.display = this.tracks.length < this.MAX_TRACKS ? '' : 'none';

        const s = track.stats;
        const isExp = this.isExpanded;

        // Stats row (4 columns: DISTANZA | DISLIVELLO | TEMPO | MAX ELE)
        let html = `<div class="tp-stats-row ${isExp ? 'expanded' : ''}">
            <div class="tp-stat">
                <span class="tp-stat-label">DISTANZA</span>
                <span class="tp-stat-value">${s.totalDistance.toFixed(1)}<small>km</small></span>
            </div>
            <div class="tp-stat">
                <span class="tp-stat-label">DISLIVELLO</span>
                <span class="tp-stat-value tp-stat-gain">+${Math.round(s.elevationGain)}<small>m</small></span>
            </div>
            <div class="tp-stat">
                <span class="tp-stat-label">TEMPO</span>
                <span class="tp-stat-value">${this.formatDuration(s.totalTimeSeconds || 0)}</span>
            </div>
            <div class="tp-stat">
                <span class="tp-stat-label">MAX ELE</span>
                <span class="tp-stat-value">${Math.round(s.maxElevation)}<small>m</small></span>
            </div>
        </div>`;

        // Extra stats (shown when expanded)
        if (isExp) {
            html += `<div class="tp-stats-extra">
                <div class="tp-stat-mini"><span class="tp-stat-mini-label">Pendenza Max</span><span class="tp-stat-mini-val accent">${s.maxGrade?.toFixed(1) || '-'}%</span></div>
                <div class="tp-stat-mini"><span class="tp-stat-mini-label">VAM</span><span class="tp-stat-mini-val">${s.vam || '-'}<small>m/h</small></span></div>
                <div class="tp-stat-mini"><span class="tp-stat-mini-label">Negativo</span><span class="tp-stat-mini-val danger">-${Math.round(s.elevationLoss)}<small>m</small></span></div>
                <div class="tp-stat-mini"><span class="tp-stat-mini-label">Vel. Media</span><span class="tp-stat-mini-val">${s.avgSpeedKmh?.toFixed(1) || '-'}<small>km/h</small></span></div>
            </div>`;
        }

        // Interactive elevation chart
        const elePadding = (s.maxElevation - s.minElevation) * 0.1;
        const chartMaxEle = s.maxElevation + elePadding;
        const chartMinEle = s.minElevation - elePadding;

        html += `<div class="tp-chart-container ${isExp ? 'expanded' : ''}" id="tp-chart" data-track-id="${track.id}">
            <svg class="tp-chart-svg" preserveAspectRatio="none" viewBox="0 0 1000 200">
                <defs>
                    <linearGradient id="tpChartGrad" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stop-color="#ea580c" stop-opacity="0.4"/>
                        <stop offset="100%" stop-color="#ea580c" stop-opacity="0.0"/>
                    </linearGradient>
                </defs>
                <path d="M0,200 ${this._chartPath(track.points, 1000, 200, chartMinEle, chartMaxEle, s.totalDistance)} L1000,200Z" fill="url(#tpChartGrad)"/>
                <path d="M0,200 ${this._chartPath(track.points, 1000, 200, chartMinEle, chartMaxEle, s.totalDistance)}" fill="none" stroke="#ea580c" stroke-width="2"/>
                <line id="tp-hover-line" x1="0" y1="0" x2="0" y2="200" stroke="white" stroke-width="1" stroke-dasharray="4 2" style="display:none"/>
                <circle id="tp-hover-circle" cx="0" cy="0" r="6" fill="#3b82f6" stroke="white" stroke-width="2" style="display:none"/>
            </svg>
            <div id="tp-tooltip" class="tp-tooltip" style="display:none">
                <div class="tp-tooltip-ele" id="tp-tooltip-ele">0m</div>
                <div class="tp-tooltip-dist" id="tp-tooltip-dist">0km</div>
            </div>
        </div>`;

        tpBody.innerHTML = html;

        // Attach chart interaction events
        this._attachChartEvents(track);

        // Attach tab click events if multiple tracks
        if (this.tracks.length > 1) {
            tpNameLabel.querySelectorAll('.tp-tab').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const tid = btn.dataset.trackId;
                    tp.dataset.focusedTrack = tid;
                    const t = this.tracks.find(tr => tr.id === tid);
                    if (t) this.centerOnTrack(t, true);
                    this.renderPanel();
                });
            });
        }
    },

    // ── Attach mouse/touch events to the elevation chart ──
    _attachChartEvents(track) {
        const chartEl = document.getElementById('tp-chart');
        if (!chartEl) return;

        const hoverLine = document.getElementById('tp-hover-line');
        const hoverCircle = document.getElementById('tp-hover-circle');
        const tooltip = document.getElementById('tp-tooltip');
        const tooltipEle = document.getElementById('tp-tooltip-ele');
        const tooltipDist = document.getElementById('tp-tooltip-dist');

        const s = track.stats;
        const elePadding = (s.maxElevation - s.minElevation) * 0.1;
        const chartMaxEle = s.maxElevation + elePadding;
        const chartMinEle = s.minElevation - elePadding;
        const eleRange = chartMaxEle - chartMinEle || 1;

        const handleMove = (clientX) => {
            if (!track.points || track.points.length === 0) return;
            const rect = chartEl.getBoundingClientRect();
            const x = clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, x / rect.width));
            const index = Math.floor(ratio * (track.points.length - 1));
            const pt = track.points[index];
            if (!pt) return;

            const svgX = (index / (track.points.length - 1)) * 1000;
            const svgY = 200 - ((pt.ele - chartMinEle) / eleRange) * 200;

            // Update SVG elements
            if (hoverLine) {
                hoverLine.setAttribute('x1', svgX);
                hoverLine.setAttribute('x2', svgX);
                hoverLine.style.display = '';
            }
            if (hoverCircle) {
                hoverCircle.setAttribute('cx', svgX);
                hoverCircle.setAttribute('cy', svgY);
                hoverCircle.style.display = '';
            }

            // Update tooltip
            if (tooltip) {
                tooltip.style.display = '';
                tooltipEle.textContent = `${Math.round(pt.ele)}m`;
                tooltipDist.textContent = `${pt.dist.toFixed(1)}km`;
            }

            // Update blue dot on map
            this.setHoverMarker(pt.lat, pt.lng);
        };

        const handleLeave = () => {
            if (hoverLine) hoverLine.style.display = 'none';
            if (hoverCircle) hoverCircle.style.display = 'none';
            if (tooltip) tooltip.style.display = 'none';
            this.removeHoverMarker();
        };

        chartEl.addEventListener('mousemove', (e) => handleMove(e.clientX));
        chartEl.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches[0]) handleMove(e.touches[0].clientX);
        }, { passive: false });
        chartEl.addEventListener('mouseleave', handleLeave);
        chartEl.addEventListener('touchend', handleLeave);
    },

    // ── Handle file upload ──
    handleFileUpload(file, mapInstance) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.gpx')) {
            alert('Per favore seleziona un file GPX valido');
            return;
        }
        if (this.tracks.length >= this.MAX_TRACKS) {
            alert('Puoi caricare massimo 2 tracce contemporaneamente.');
            return;
        }

        this.mapRef = mapInstance;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const text = e.target.result;
                const newTrack = this.parseAndCreateTrack(text, file.name);
                this.tracks.push(newTrack);
                this.displayTrackOnMap(newTrack);
                this.openPanel(newTrack.id);
                // Trigger bivacchi filter refresh
                if (typeof aggiornaInterfaccia === 'function') aggiornaInterfaccia();
            } catch (err) {
                console.error('GPX Parse Error:', err);
                alert('Errore nel caricamento del file GPX: ' + err.message);
            }
        };
        reader.onerror = () => alert('Errore nella lettura del file');
        reader.readAsText(file);
    },

    // ── Setup panel interaction (swipe, close, add) ──
    initPanelEvents() {
        const tp = document.getElementById('track-panel');
        const handle = document.getElementById('tp-handle');
        const closeBtn = document.getElementById('btn-close-track');
        const addBtn = document.getElementById('btn-add-gpx');

        if (!tp) return;

        // Swipe on handle to expand/collapse/close
        if (handle) {
            handle.addEventListener('click', () => {
                this.isExpanded = !this.isExpanded;
                tp.classList.toggle('tp-expanded', this.isExpanded);
                this.renderPanel();
            });

            handle.addEventListener('touchstart', (e) => {
                this._touchStartY = e.touches[0].clientY;
            }, { passive: true });

            handle.addEventListener('touchend', (e) => {
                if (this._touchStartY !== null) {
                    const diff = this._touchStartY - e.changedTouches[0].clientY;
                    if (diff > 50 && !this.isExpanded) {
                        // Swipe up → expand
                        this.isExpanded = true;
                        tp.classList.add('tp-expanded');
                        this.renderPanel();
                    } else if (diff < -50) {
                        if (this.isExpanded) {
                            // Swipe down → collapse
                            this.isExpanded = false;
                            tp.classList.remove('tp-expanded');
                            this.renderPanel();
                        } else {
                            // Swipe down from collapsed → close
                            this.closePanel();
                            const t = this.getFocusedTrack();
                            if (t) this.centerOnTrack(t, false);
                        }
                    }
                    this._touchStartY = null;
                }
            });
        }

        // Close button
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.closePanel();
                const t = this.getFocusedTrack();
                if (t) this.centerOnTrack(t, false);
            });
        }

        // Add GPX button
        if (addBtn) {
            addBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                document.getElementById('gpx-file-input')?.click();
            });
        }
    },

    // ── Escape HTML ──
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    },

    // === LEGACY COMPAT (used by old script.js references) ===
    get currentStats() {
        const t = this.getFocusedTrack();
        return t ? t.stats : null;
    },
    get currentTrackName() {
        const t = this.getFocusedTrack();
        return t ? t.name : '';
    },
    get elevationData() {
        const t = this.getFocusedTrack();
        return t ? t.points : [];
    },
    showStatsPanel(stats, trackName) { this.openPanel(); },
    closeStatsPanel() { this.closePanel(); },
    clearCurrentTrack() { this.clearAll(); },
    generateStatsHTML() { return ''; },
    renderElevationProfile() {},
    toggleStatsPanel() {
        const tp = document.getElementById('track-panel');
        if (tp?.classList.contains('tp-open')) this.closePanel();
        else this.openPanel();
    }
};

// Make globally available
window.GPXService = GPXService;
