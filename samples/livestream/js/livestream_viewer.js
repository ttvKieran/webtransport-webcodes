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
        
        this.initUI();
        this.checkUrlParams();
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
        
        // Setup stream reader IMMEDIATELY (before waiting for ready)
        console.log('Setting up incoming stream reader...');
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
            
            // Parse frame header
            if (data.byteLength < 16) {
                console.error(`Frame too short: ${data.byteLength} bytes`);
                return;
            }
            
            const view = new DataView(data.buffer);
            const timestamp = Number(view.getBigUint64(0, true));
            const duration = view.getUint32(8, true);
            const isKey = view.getUint8(12) === 1;
            const size = view.getUint32(13, true) & 0xFFFFFF; // 3 bytes
            
            const frameData = data.slice(16);
            
            console.log(`Frame header - timestamp: ${timestamp}, duration: ${duration}, isKey: ${isKey}, size: ${size}, actual: ${frameData.byteLength}`);
            
            // Create EncodedVideoChunk
            const chunk = new EncodedVideoChunk({
                type: isKey ? 'key' : 'delta',
                timestamp: timestamp,
                duration: duration,
                data: frameData
            });
            
            // Configure decoder on first keyframe
            if (isKey && this.decoder.state === 'unconfigured') {
                this.log('Found keyframe, configuring decoder...', 'info');
                await this.configureDecoderFromChunk(chunk, frameData);
            }
            
            // Decode frame
            if (this.decoder.state === 'configured') {
                this.decoder.decode(chunk);
                this.stats.framesReceived++;
                this.stats.fpsCounter++;
                
                // Calculate latency
                const now = Date.now();
                const latency = now - (timestamp / 1000);
                this.stats.latencySum += latency;
                this.stats.latencyCount++;
                
                console.log(`Decoded frame #${this.stats.framesReceived} (keyframe: ${isKey})`);
            } else {
                console.warn(`Skipping frame - decoder state: ${this.decoder.state}, isKey: ${isKey}`);
            }
            
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
        
        // Limit buffer size
        while (this.frameBuffer.length > this.maxBufferSize) {
            const droppedFrame = this.frameBuffer.shift();
            droppedFrame.close();
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
                    
                    // Draw frame to canvas
                    this.ctx.drawImage(frame, 0, 0);
                    
                } catch (error) {
                    if (this.isPlaying) {
                        console.error('Playback error:', error);
                    }
                }
                
                frame.close();
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
        if (elapsed >= 1) {
            const fps = Math.round(this.stats.fpsCounter / elapsed);
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
