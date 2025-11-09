class LivestreamViewer {
    constructor() {
        this.transport = null;
        this.decoder = null;
        this.isConnected = false;
        this.videoTrack = null;
        this.generator = null;
        this.writable = null;
        this.writer = null;
        
        // Frame buffer for smooth playback
        this.frameBuffer = [];
        this.maxBufferSize = 5; // Buffer up to 5 frames
        this.isPlaying = false;
        
        // Statistics
        this.stats = {
            framesReceived: 0,
            bytesReceived: 0,
            droppedFrames: 0,
            lastFpsUpdate: Date.now(),
            fpsCounter: 0,
            latencySum: 0,
            latencyCount: 0
        };

        // Packet tracking for datagrams
        this.stats.lastSeq = null;
        this.stats.packetsLost = 0;
        this.stats.totalPackets = 0;
        
        this.initUI();
        this.checkUrlParams();

        // Reassembly buffers for fragmented frames: key = `${sessionId}:${seq}`
        this.reassembly = new Map();

        // Periodically clean up stale reassembly entries
        setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.reassembly.entries()) {
                if (now - entry.ts > 5000) { // 5s timeout
                    this.reassembly.delete(key);
                    console.warn(`Reassembly entry expired: ${key}`);
                }
            }
        }, 2000);

        // Resend request cooldown to avoid spamming server
        this._lastResendRequestTs = 0;
        this._resendCooldownMs = 5000; // 5 seconds
    }
    
    initUI() {
        // Get DOM elements
        this.elements = {
            connectBtn: document.getElementById('connect-btn'),
            disconnectBtn: document.getElementById('disconnect-btn'),
            remoteVideo: document.getElementById('remote-video'),
            videoOverlay: document.getElementById('video-overlay'),
            statusBadge: document.getElementById('status-badge'),
            log: document.getElementById('log'),
            
            // Config
            serverUrl: document.getElementById('server-url'),
            
            // Stats displays
            framesReceivedDisplay: document.getElementById('frames-received'),
            bytesReceivedDisplay: document.getElementById('bytes-received'),
            fpsDisplay: document.getElementById('fps'),
            latencyDisplay: document.getElementById('latency'),
            bufferSizeDisplay: document.getElementById('buffer-size'),
            droppedFramesDisplay: document.getElementById('dropped-frames'),
            packetLossDisplay: document.getElementById('packet-loss'),
            
            // Quality indicators
            qualityBars: [
                document.getElementById('q1'),
                document.getElementById('q2'),
                document.getElementById('q3'),
                document.getElementById('q4'),
                document.getElementById('q5')
            ],
            qualityText: document.getElementById('quality-text')
        };
        
        // Event listeners
        this.elements.connectBtn.addEventListener('click', () => this.connect());
        this.elements.disconnectBtn.addEventListener('click', () => this.disconnect());
        
        // Stats update interval
        setInterval(() => this.updateStats(), 1000);
    }
    
    checkUrlParams() {
        const params = new URLSearchParams(window.location.search);
        const streamId = params.get('stream');
        
        if (streamId) {
            const baseUrl = this.elements.serverUrl.value.split('/watch/')[0];
            this.elements.serverUrl.value = `${baseUrl}/watch/${streamId}`;
            this.log(`Auto-loaded stream: ${streamId}`, 'info');
        }
    }
    
    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${timestamp}] ${message}`;
        this.elements.log.appendChild(entry);
        this.elements.log.scrollTop = this.elements.log.scrollHeight;
        console.log(`[${type.toUpperCase()}] ${message}`);
    }
    
    updateStatus(text, className) {
        this.elements.statusBadge.textContent = text;
        this.elements.statusBadge.className = `status-badge ${className}`;
        this.elements.statusBadge.style.display = 'block';
    }
    
    async connect() {
        try {
            this.log('Connecting to livestream...', 'info');
            this.elements.connectBtn.disabled = true;
            this.updateStatus('⏳ Connecting...', 'connecting');
            
            // Connect to WebTransport server (this will setup stream reader too)
            await this.connectTransport();
            
            // Initialize video decoder (will configure when first frame arrives)
            await this.initDecoder();
            
            this.isConnected = true;
            this.elements.disconnectBtn.disabled = false;
            this.updateStatus('🔴 LIVE', 'live');
            this.elements.videoOverlay.classList.add('hidden');
            
            this.log('Connected to livestream! Waiting for video frames...', 'success');
        } catch (error) {
            this.log(`Connection error: ${error.message}`, 'error');
            this.elements.connectBtn.disabled = false;
            this.elements.statusBadge.style.display = 'none';
            this.cleanup();
        }
    }
    
    async disconnect() {
        this.log('Disconnecting from livestream...', 'info');
        this.isConnected = false;
        this.cleanup();
        this.elements.connectBtn.disabled = false;
        this.elements.disconnectBtn.disabled = true;
        this.elements.statusBadge.style.display = 'none';
        this.elements.videoOverlay.classList.remove('hidden');
        this.log('Disconnected', 'info');
    }
    
    async connectTransport() {
        const url = this.elements.serverUrl.value;
        this.log(`Connecting to ${url}...`, 'info');
        
        this.transport = new WebTransport(url);
        
    // Setup datagram reader (preferred) and stream reader as fallback
    console.log('Setting up incoming datagram + stream readers...');
    this.setupDatagramReader();
    this.setupStreamReader();
        
        await this.transport.ready;
        this.log('WebTransport connected!', 'success');
        
        // Handle connection closure
        this.transport.closed.then(() => {
            this.log('WebTransport connection closed', 'info');
            if (this.isConnected) {
                this.disconnect();
            }
        }).catch(error => {
            this.log(`WebTransport error: ${error.message}`, 'error');
            if (this.isConnected) {
                this.disconnect();
            }
        });
    }
    
    setupStreamReader() {
        // Start reading incoming streams immediately
        const streamReader = this.transport.incomingUnidirectionalStreams.getReader();
        
        (async () => {
            console.log('Stream reader loop started');
            while (true) {
                try {
                    const { value: stream, done } = await streamReader.read();
                    
                    if (done) {
                        console.log('Stream reader done');
                        break;
                    }
                    
                    console.log('Received new incoming stream');
                    
                    // Each stream contains one encoded frame
                    this.receiveFrame(stream);
                    
                } catch (error) {
                    console.error('Stream reading error:', error);
                    break;
                }
            }
            
            console.log('Stream reader loop exited');
        })();
        
        this.log('Stream reader setup complete', 'success');
    }

    setupDatagramReader() {
        if (!this.transport || !this.transport.datagrams || !this.transport.datagrams.readable) {
            this.log('Datagrams not supported by this WebTransport implementation - streams will be used as fallback', 'info');
            return;
        }

        const reader = this.transport.datagrams.readable.getReader();

        (async () => {
            this.log('Datagram reader loop started', 'info');
            while (true) {
                try {
                    const { value, done } = await reader.read();
                    if (done) break;

                    if (!value) continue;
                    // value is a Uint8Array
                    console.log(`Received datagram: ${value.byteLength} bytes`);
                    this.stats.bytesReceived += value.byteLength;
                    // Process datagram frame (header + payload)
                    await this.processFrameData(value);

                } catch (error) {
                    console.error('Datagram reader error:', error);
                    break;
                }
            }

            this.log('Datagram reader loop exited', 'info');
        })();

        this.log('Datagram reader setup complete', 'success');
    }

    async processFrameData(data) {
        try {
            // New header layout (24 bytes):
            // [session_id:uint32][seq:uint32][timestamp:uint64][duration:uint32][flags:uint8][pad:3]
            const HEADER_LEN = 24;
            if (data.byteLength < HEADER_LEN) {
                console.error(`Frame too short: ${data.byteLength} bytes`);
                return;
            }

            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            const sessionId = view.getUint32(0, true);
            const seq = view.getUint32(4, true);
            const timestamp = Number(view.getBigUint64(8, true)); // microseconds since epoch
            const duration = view.getUint32(16, true);
            const flags = view.getUint8(20);
            const isKey = (flags & 0x01) === 1;
            const isFragmented = (flags & 0x80) !== 0;

            // If fragmented, read frag header (frag_index, frag_count) at HEADER_LEN
            let frameData = null;
            if (isFragmented) {
                if (data.byteLength < HEADER_LEN + 4) {
                    console.warn('Fragment too short');
                    return;
                }
                const fv = new DataView(data.buffer, data.byteOffset + HEADER_LEN, 4);
                const fragIndex = fv.getUint16(0, true);
                const fragCount = fv.getUint16(2, true);

                const payload = data.slice(HEADER_LEN + 4);

                const key = `${sessionId}:${seq}`;
                let entry = this.reassembly.get(key);
                if (!entry) {
                    entry = {
                        frags: new Array(fragCount),
                        received: 0,
                        fragCount: fragCount,
                        ts: Date.now()
                    };
                    this.reassembly.set(key, entry);
                }

                if (!entry.frags[fragIndex]) {
                    entry.frags[fragIndex] = payload;
                    entry.received++;
                }

                if (entry.received === entry.fragCount) {
                    // Reassemble
                    let total = 0;
                    for (let i = 0; i < entry.fragCount; i++) total += entry.frags[i].length;
                    const assembledPayload = new Uint8Array(total);
                    let off = 0;
                    for (let i = 0; i < entry.fragCount; i++) {
                        assembledPayload.set(entry.frags[i], off);
                        off += entry.frags[i].length;
                    }
                    frameData = assembledPayload;
                    this.reassembly.delete(key);
                } else {
                    // Wait for more fragments
                    return;
                }
            } else {
                frameData = data.slice(HEADER_LEN);
            }

            // Packet loss accounting
            try {
                if (this.stats.lastSeq !== null) {
                    const expected = (this.stats.lastSeq + 1) >>> 0;
                    if (seq !== expected) {
                        // Simple detection: if seq > lastSeq, count missing frames
                        if (seq > this.stats.lastSeq) {
                            const lost = seq - expected;
                            if (lost > 0) {
                                this.stats.packetsLost += lost;
                                console.warn(`Detected packet loss: ${lost} packets (seq ${this.stats.lastSeq} -> ${seq})`);
                            }
                        } else {
                            // wrap-around or re-order; for now, log
                            console.warn(`Sequence jump or wrap detected: last=${this.stats.lastSeq}, now=${seq}`);
                        }
                    }
                }
                this.stats.lastSeq = seq;
                this.stats.totalPackets++;
                // Save current session id observed
                this.currentSessionId = sessionId;

                // If packet loss percentage exceeds threshold, request keyframe resend (debounced)
                const lossPct = this.stats.totalPackets > 0 ? (this.stats.packetsLost / this.stats.totalPackets) * 100 : 0;
                if (this.stats.packetsLost > 0 && lossPct >= 5) {
                    const now = Date.now();
                    if (now - this._lastResendRequestTs > this._resendCooldownMs) {
                        this._lastResendRequestTs = now;
                        this.requestKeyframeResend();
                    }
                }
            } catch (e) {
                console.warn('Packet loss accounting error', e);
            }

            // Sanity-check timestamp: convert to ms
            const nowMs = Date.now();
            const tsMs = Math.round(timestamp / 1000);
            if (tsMs > nowMs + 60000) {
                console.warn(`Frame timestamp too far in future (${tsMs} > ${nowMs}), skipping`);
                return;
            }

            // Create EncodedVideoChunk
            const chunk = new EncodedVideoChunk({
                type: isKey ? 'key' : 'delta',
                timestamp: Number(timestamp),
                duration: duration,
                data: frameData
            });

            // Configure decoder on first keyframe
            if (isKey && this.decoder.state === 'unconfigured') {
                this.log('Found keyframe in datagram, configuring decoder...', 'info');
                await this.configureDecoderFromChunk(chunk, frameData);
            }

            if (this.decoder.state === 'configured') {
                this.decoder.decode(chunk);
                this.stats.framesReceived++;
                this.stats.fpsCounter++;

                // Calculate latency (ms)
                const latency = nowMs - tsMs;
                if (latency >= 0 && latency < 60000) {
                    this.stats.latencySum += latency;
                    this.stats.latencyCount++;
                }
            } else {
                console.warn(`Skipping datagram frame - decoder state: ${this.decoder.state}, isKey: ${isKey}`);
            }

        } catch (error) {
            console.error('processFrameData error:', error);
        }
    }

    async requestKeyframeResend() {
        try {
            if (!this.transport || this.transport.state === 'closed' || this.transport.state === 'failed') return;
            if (!this.currentSessionId) {
                console.warn('No session id known, cannot request keyframe resend');
                return;
            }

            const msg = JSON.stringify({ type: 'resend_keyframe', session_key: this.currentSessionId });

            // Send as a unidirectional stream to server (viewer -> server control)
            const stream = await this.transport.createUnidirectionalStream();
            const writer = stream.getWriter();
            await writer.write(new TextEncoder().encode(msg));
            await writer.close();

            this.log('Requested keyframe resend from server', 'info');
        } catch (e) {
            console.warn('Failed to request keyframe resend', e);
        }
    }
    
    async initDecoder() {
        this.log('Initializing video decoder...', 'info');
        
        this.decoder = new VideoDecoder({
            output: (frame) => this.handleDecodedFrame(frame),
            error: (error) => this.log(`Decoder error: ${error.message}`, 'error')
        });
        
        // Will configure when first frame arrives with metadata
        this.log('Decoder ready (waiting for configuration)', 'success');
    }
    
    async receiveFrame(stream) {
        try {
            console.log('Reading frame from stream...');
            const reader = stream.getReader();
            const chunks = [];
            
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                chunks.push(value);
            }
            
            console.log(`Read ${chunks.length} chunks from stream`);
            
            // Combine chunks
            const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
            const data = new Uint8Array(totalLength);
            let offset = 0;
            for (const chunk of chunks) {
                data.set(chunk, offset);
                offset += chunk.length;
            }
            
            this.stats.bytesReceived += data.byteLength;
            
            console.log(`Received frame: ${data.byteLength} bytes`);
            // Delegate to shared frame processor (works for datagram & stream)
            await this.processFrameData(data);
            
        } catch (error) {
            if (this.isConnected) {
                this.log(`Frame receive error: ${error.message}`, 'error');
                console.error('Frame receive error:', error);
            }
        }
    }
    
    async configureDecoderFromChunk(chunk, frameData) {
        this.log('Configuring decoder from first keyframe...', 'info');
        
        // Try to detect codec from frame data
        let codec = 'vp8';
        
        // Simple heuristic: VP8 starts with specific bytes
        if (frameData[0] === 0x10 || frameData[0] === 0x30) {
            codec = 'vp8';
        } else if (frameData[0] === 0x82 || frameData[0] === 0x83) {
            codec = 'vp09.00.10.08';
        }
        
        try {
            this.decoder.configure({
                codec: codec,
                optimizeForLatency: true
            });
            
            this.log(`Decoder configured with codec: ${codec}`, 'success');
            
            // Initialize video output
            await this.initVideoOutput();
            
        } catch (error) {
            this.log(`Decoder configuration error: ${error.message}`, 'error');
            throw error;
        }
    }
    
    async initVideoOutput() {
        // Use canvas to render decoded frames
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        
        // Replace video with canvas
        const video = this.elements.remoteVideo;
        canvas.width = video.offsetWidth || 1280;
        canvas.height = video.offsetHeight || 720;
        canvas.style.width = '100%';
        canvas.style.maxHeight = '600px';
        canvas.style.display = 'block';
        canvas.style.objectFit = 'contain';
        canvas.style.background = '#000';
        
        // Replace video element with canvas
        video.parentNode.replaceChild(canvas, video);
        this.elements.remoteVideo = canvas;
        this.canvas = canvas;
        this.ctx = ctx;
        
        this.log('Video output initialized (canvas renderer)', 'success');
        
        // Start playback loop
        this.startPlayback();
    }
    
    async handleDecodedFrame(frame) {
        // Add to buffer
        this.frameBuffer.push(frame);
        
        // Limit buffer size immediately to avoid memory growth
        while (this.frameBuffer.length > this.maxBufferSize) {
            const droppedFrame = this.frameBuffer.shift();
            try { droppedFrame.close(); } catch (e) {}
            this.stats.droppedFrames++;
        }
    }
    
    async startPlayback() {
        this.isPlaying = true;
        this.playbackLoop();
    }
    
    async playbackLoop() {
        while (this.isPlaying && this.isConnected) {
            if (this.frameBuffer.length > 0) {
                const frame = this.frameBuffer.shift();
                
                try {
                    // Resize canvas if needed
                    if (this.canvas.width !== frame.displayWidth || 
                        this.canvas.height !== frame.displayHeight) {
                        this.canvas.width = frame.displayWidth;
                        this.canvas.height = frame.displayHeight;
                    }
                    
                    // Draw frame to canvas using a bitmap for better performance
                    try {
                        const bitmap = await createImageBitmap(frame);
                        this.ctx.drawImage(bitmap, 0, 0);
                        bitmap.close();
                    } catch (innerErr) {
                        console.error('drawImage/createImageBitmap error:', innerErr);
                    }
                } catch (error) {
                    if (this.isPlaying) {
                        console.error('Playback error:', error);
                    }
                } finally {
                    try { frame.close(); } catch (e) {}
                }
            }
            
            // Wait for next animation frame
            await new Promise(resolve => requestAnimationFrame(resolve));
        }
    }
    
    updateStats() {
        // Update frames received
        this.elements.framesReceivedDisplay.textContent = this.stats.framesReceived.toLocaleString();
        
        // Update bytes received (in KB)
        const kb = Math.round(this.stats.bytesReceived / 1024);
        this.elements.bytesReceivedDisplay.textContent = kb.toLocaleString();
        
        // Update FPS
        const now = Date.now();
        const elapsed = (now - this.stats.lastFpsUpdate) / 1000;
        if (elapsed >= 0.25) {
            const fps = Math.round(this.stats.fpsCounter / Math.max(elapsed, 0.0001));
            this.elements.fpsDisplay.textContent = fps;
            this.stats.fpsCounter = 0;
            this.stats.lastFpsUpdate = now;

            // Update quality indicator based on FPS
            this.updateQualityIndicator(fps);
        }
        
        // Update latency
        if (this.stats.latencyCount > 0) {
            const avgLatency = Math.round(this.stats.latencySum / this.stats.latencyCount);
            this.elements.latencyDisplay.textContent = avgLatency;
            this.stats.latencySum = 0;
            this.stats.latencyCount = 0;
        }
        
    // Update buffer size
        this.elements.bufferSizeDisplay.textContent = this.frameBuffer.length;
        
        // Update dropped frames
        this.elements.droppedFramesDisplay.textContent = this.stats.droppedFrames.toLocaleString();

        // Update packet loss display (if element exists)
        if (this.elements.packetLossDisplay) {
            const lossPct = this.stats.totalPackets > 0 ? Math.round((this.stats.packetsLost / this.stats.totalPackets) * 100) : 0;
            this.elements.packetLossDisplay.textContent = `${this.stats.packetsLost} (${lossPct}%)`;
        }
    }
    
    updateQualityIndicator(fps) {
        let activeCount = 5;
        let qualityText = 'Excellent';
        
        if (fps < 10) {
            activeCount = 1;
            qualityText = 'Poor';
        } else if (fps < 20) {
            activeCount = 2;
            qualityText = 'Fair';
        } else if (fps < 25) {
            activeCount = 3;
            qualityText = 'Good';
        } else if (fps < 30) {
            activeCount = 4;
            qualityText = 'Very Good';
        }
        
        this.elements.qualityBars.forEach((bar, index) => {
            if (index < activeCount) {
                bar.classList.add('active');
            } else {
                bar.classList.remove('active');
            }
        });
        
        this.elements.qualityText.textContent = qualityText;
    }
    
    cleanup() {
        // Stop playback
        this.isPlaying = false;
        
        // Clear buffer
        while (this.frameBuffer.length > 0) {
            const frame = this.frameBuffer.shift();
            frame.close();
        }
        
        // Close decoder
        if (this.decoder) {
            if (this.decoder.state !== 'closed') {
                this.decoder.close();
            }
            this.decoder = null;
        }
        
        // Close transport
        if (this.transport) {
            try {
                this.transport.close();
            } catch (e) {
                // Ignore
            }
            this.transport = null;
        }
        
        // Clear canvas
        if (this.ctx && this.canvas) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        
        // Reset quality indicator
        this.elements.qualityBars.forEach(bar => bar.classList.remove('active'));
        this.elements.qualityText.textContent = 'Disconnected';
    }
}

// Initialize viewer when page loads
let viewer;
window.addEventListener('DOMContentLoaded', () => {
    viewer = new LivestreamViewer();
    console.log('Livestream Viewer initialized');
});
