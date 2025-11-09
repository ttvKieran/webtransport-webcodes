class LivestreamPublisher {
    constructor() {
        this.transport = null;
        this.encoder = null;
        this.stream = null;
        this.videoTrack = null;
        this.processorReader = null;
        this.isStreaming = false;
        
        // Statistics
        this.stats = {
            framesSent: 0,
            bytesSent: 0,
            startTime: null,
            lastFpsUpdate: Date.now(),
            fpsCounter: 0
        };
        
        // Configuration
        this.config = {
            codec: 'VP8',
            // Lower defaults for better reliability by default
            bitrate: 500000,
            framerate: 20,
            width: 640,
            height: 360
        };
        
        this.initUI();
    }
    
    initUI() {
        // Get DOM elements
        this.elements = {
            startBtn: document.getElementById('start-btn'),
            stopBtn: document.getElementById('stop-btn'),
            localVideo: document.getElementById('local-video'),
            statusLabel: document.getElementById('status-label'),
            log: document.getElementById('log'),
            shareSection: document.getElementById('share-section'),
            viewerUrl: document.getElementById('viewer-url'),
            
            // Config inputs
            serverUrl: document.getElementById('server-url'),
            codecSelect: document.getElementById('codec'),
            bitrateInput: document.getElementById('bitrate'),
            framerateInput: document.getElementById('framerate'),
            
            // Stats displays
            framesSentDisplay: document.getElementById('frames-sent'),
            bytesSentDisplay: document.getElementById('bytes-sent'),
            fpsDisplay: document.getElementById('fps'),
            durationDisplay: document.getElementById('duration')
        };
        
        // Event listeners
        this.elements.startBtn.addEventListener('click', () => this.start());
        this.elements.stopBtn.addEventListener('click', () => this.stop());
        
        // Update config on input change
        this.elements.codecSelect.addEventListener('change', (e) => {
            this.config.codec = e.target.value;
        });
        this.elements.bitrateInput.addEventListener('change', (e) => {
            this.config.bitrate = parseInt(e.target.value);
        });
        this.elements.framerateInput.addEventListener('change', (e) => {
            this.config.framerate = parseInt(e.target.value);
        });
        
        // Stats update interval
        setInterval(() => this.updateStats(), 1000);
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
    
    updateStatus(text, isLive = false) {
        this.elements.statusLabel.textContent = text;
        if (isLive) {
            this.elements.statusLabel.classList.add('live');
        } else {
            this.elements.statusLabel.classList.remove('live');
        }
    }
    
    async start() {
        try {
            this.log('Starting livestream...', 'info');
            this.elements.startBtn.disabled = true;
            
            // Get camera access
            await this.startCamera();
            
            // Connect to WebTransport server
            await this.connectTransport();
            
            // Initialize video encoder
            await this.initEncoder();
            
            // Start encoding loop
            this.startEncoding();
            
            this.isStreaming = true;
            this.stats.startTime = Date.now();
            this.elements.stopBtn.disabled = false;
            this.updateStatus('🔴 LIVE', true);
            
            // Show viewer URL
            const serverUrl = this.elements.serverUrl.value;
            const streamId = serverUrl.split('/').pop();
            const viewerUrl = `${window.location.origin}/samples/livestream/viewer.html?stream=${streamId}`;
            this.elements.viewerUrl.textContent = viewerUrl;
            this.elements.shareSection.style.display = 'block';
            
            this.log('Livestream started successfully!', 'success');
        } catch (error) {
            this.log(`Error starting livestream: ${error.message}`, 'error');
            this.elements.startBtn.disabled = false;
            this.cleanup();
        }
    }
    
    async stop() {
        this.log('Stopping livestream...', 'info');
        this.isStreaming = false;
        this.cleanup();
        this.elements.startBtn.disabled = false;
        this.elements.stopBtn.disabled = true;
        this.updateStatus('📹 Stopped', false);
        this.log('Livestream stopped', 'info');
    }
    
    async startCamera() {
        this.log('Requesting camera access...', 'info');
        
        const constraints = {
            video: {
                width: { ideal: this.config.width },
                height: { ideal: this.config.height },
                frameRate: { ideal: this.config.framerate }
            },
            audio: false
        };
        
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.videoTrack = this.stream.getVideoTracks()[0];
        this.elements.localVideo.srcObject = this.stream;
        
        const settings = this.videoTrack.getSettings();
        this.config.width = settings.width;
        this.config.height = settings.height;
        
        this.log(`Camera started: ${settings.width}x${settings.height} @ ${settings.frameRate}fps`, 'success');
    }
    
    async connectTransport() {
        const url = this.elements.serverUrl.value;
        this.log(`Connecting to ${url}...`, 'info');
        
        this.transport = new WebTransport(url);
        
        await this.transport.ready;
        this.log('WebTransport connected!', 'success');
        
        // Handle connection closure
        this.transport.closed.then(() => {
            this.log('WebTransport connection closed', 'info');
            if (this.isStreaming) {
                this.stop();
            }
        }).catch(error => {
            this.log(`WebTransport error: ${error.message}`, 'error');
            if (this.isStreaming) {
                this.stop();
            }
        });
    }
    
    async initEncoder() {
        this.log('Initializing video encoder...', 'info');
        
        const codecString = this.getCodecString();
        
        // Check codec support
        const support = await VideoEncoder.isConfigSupported({
            codec: codecString,
            width: this.config.width,
            height: this.config.height,
            bitrate: this.config.bitrate,
            framerate: this.config.framerate
        });
        
        if (!support.supported) {
            throw new Error(`Codec ${codecString} not supported`);
        }
        
        this.log(`Using codec: ${codecString}`, 'info');
        
        this.encoder = new VideoEncoder({
            output: (chunk, metadata) => this.handleEncodedChunk(chunk, metadata),
            error: (error) => this.log(`Encoder error: ${error.message}`, 'error')
        });
        
        this.encoder.configure({
            codec: codecString,
            width: this.config.width,
            height: this.config.height,
            bitrate: this.config.bitrate,
            framerate: this.config.framerate,
            latencyMode: 'realtime'
        });
        
        this.log('Encoder configured', 'success');
    }
    
    getCodecString() {
        const codec = this.config.codec;
        switch (codec) {
            case 'VP8':
                return 'vp8';
            case 'VP9':
                return 'vp09.00.10.08'; // VP9 Profile 0
            case 'H264':
                return 'avc1.42E01E'; // H.264 Baseline
            case 'AV1':
                return 'av01.0.05M.08'; // AV1 Main Profile
            default:
                return 'vp8';
        }
    }
    
    async startEncoding() {
        this.log('Starting encoding loop...', 'info');
        console.log('Starting frame capture...');
        
        // Always use RVFC for better compatibility
        this.useRVFC();
    }
    
    useRVFC() {
        // Use RequestVideoFrameCallback API (native Chrome support)
        const video = this.elements.localVideo;
        
        const captureFrame = (now, metadata) => {
            if (!this.isStreaming) {
                console.log('Stopped capturing frames');
                return;
            }
            
            try {
                // Create VideoFrame from video element
                const frame = new VideoFrame(video, {
                    timestamp: metadata.mediaTime * 1000000, // Convert to microseconds
                });
                
                // Encode frame
                if (this.encoder && this.encoder.state === 'configured') {
                    const keyFrame = (this.stats.framesSent % (this.config.framerate * 2)) === 0;
                    this.encoder.encode(frame, { keyFrame });
                    this.stats.fpsCounter++;
                }
                
                frame.close();
                
            } catch (error) {
                console.error('Frame capture error:', error);
            }
            
            // Request next frame
            if (this.isStreaming) {
                video.requestVideoFrameCallback(captureFrame);
            }
        };
        
        // Start capturing
        video.requestVideoFrameCallback(captureFrame);
        this.log('Using RequestVideoFrameCallback for frame capture', 'success');
        console.log('RVFC frame capture started');
    }
    
    async handleEncodedChunk(chunk, metadata) {
        try {
            console.log(`Encoding chunk: type=${chunk.type}, timestamp=${chunk.timestamp}, size=${chunk.byteLength}`);
            
            // Serialize encoded chunk
            const data = new Uint8Array(chunk.byteLength + 16);
            const view = new DataView(data.buffer);
            
            // Header: [timestamp(8), duration(4), type(1), size(3)]
            // Use epoch ms converted to microseconds so viewer can compute latency reliably
            const tsMicro = BigInt(Date.now()) * 1000n;
            view.setBigUint64(0, tsMicro, true);
            view.setUint32(8, chunk.duration || 0, true);
            view.setUint8(12, chunk.type === 'key' ? 1 : 0);
            view.setUint32(13, chunk.byteLength, true); // Only use 3 bytes in practice
            
            // Copy chunk data
            chunk.copyTo(data.subarray(16));
            
            console.log(`Serialized frame: ${data.byteLength} bytes (header: 16, payload: ${chunk.byteLength})`);
            
            // Send via WebTransport datagram when supported (faster, lower overhead)
            await this.sendDatagram(data);
            
            this.stats.framesSent++;
            this.stats.bytesSent += data.byteLength;
            
            console.log(`Frame sent successfully! Total frames: ${this.stats.framesSent}`);
            
        } catch (error) {
            this.log(`Error handling chunk: ${error.message}`, 'error');
            console.error('handleEncodedChunk error:', error);
        }
    }
    
    async sendFrame(data) {
        try {
            console.log(`Creating unidirectional stream to send ${data.byteLength} bytes...`);
            
            if (!this.transport || this.transport.state === 'closed' || this.transport.state === 'failed') {
                throw new Error('WebTransport connection is closed');
            }
            
            const stream = await this.transport.createUnidirectionalStream();
            const writer = stream.getWriter();
            await writer.write(data);
            await writer.close();
            console.log('Stream closed successfully');
        } catch (error) {
            console.error('sendFrame error:', error);
            
            // If connection is lost, stop streaming
            if (error.message.includes('Connection') || error.message.includes('closed')) {
                this.log('Connection lost, stopping stream', 'error');
                this.stop();
            }
            
            if (this.isStreaming) {
                throw error;
            }
        }
    }

    async sendDatagram(data) {
        try {
            if (!this.transport || this.transport.state === 'closed' || this.transport.state === 'failed') {
                throw new Error('WebTransport connection is closed');
            }

            // Prefer datagrams if supported
            if (this.transport.datagrams && this.transport.datagrams.send) {
                // Check datagram size (QUIC datagram frame size limit)
                const MAX_DATAGRAM_SIZE = 65536; // match server configuration
                if (data.byteLength <= MAX_DATAGRAM_SIZE) {
                    await this.transport.datagrams.send(data);
                    return;
                }
            }

            // Fallback to streams for large frames
            await this.sendFrame(data);
        } catch (error) {
            console.error('sendDatagram error:', error);

            // If connection is lost, stop streaming
            if (error.message && (error.message.includes('Connection') || error.message.includes('closed'))) {
                this.log('Connection lost, stopping stream', 'error');
                this.stop();
            }

            if (this.isStreaming) {
                throw error;
            }
        }
    }
    
    updateStats() {
        if (!this.stats.startTime) return;
        
        // Update frames sent
        this.elements.framesSentDisplay.textContent = this.stats.framesSent.toLocaleString();
        
        // Update bytes sent (in KB)
        const kb = Math.round(this.stats.bytesSent / 1024);
        this.elements.bytesSentDisplay.textContent = kb.toLocaleString();
        
        // Update FPS
        const now = Date.now();
        const elapsed = (now - this.stats.lastFpsUpdate) / 1000;
        if (elapsed >= 1) {
            const fps = Math.round(this.stats.fpsCounter / elapsed);
            this.elements.fpsDisplay.textContent = fps;
            this.stats.fpsCounter = 0;
            this.stats.lastFpsUpdate = now;
        }
        
        // Update duration
        const duration = Math.floor((Date.now() - this.stats.startTime) / 1000);
        const minutes = Math.floor(duration / 60);
        const seconds = duration % 60;
        this.elements.durationDisplay.textContent = 
            `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    
    cleanup() {
        // Stop encoding
        if (this.processorReader) {
            this.processorReader.cancel();
            this.processorReader = null;
        }
        
        // Close encoder
        if (this.encoder) {
            if (this.encoder.state !== 'closed') {
                this.encoder.close();
            }
            this.encoder = null;
        }
        
        // Stop camera
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
            this.videoTrack = null;
        }
        
        // Close transport
        if (this.transport) {
            try {
                this.transport.close();
            } catch (e) {
                // Ignore errors during cleanup
            }
            this.transport = null;
        }
        
        // Clear video
        this.elements.localVideo.srcObject = null;
        
        // Hide share section
        this.elements.shareSection.style.display = 'none';
    }
}

// Initialize publisher when page loads
let publisher;
window.addEventListener('DOMContentLoaded', () => {
    publisher = new LivestreamPublisher();
    console.log('Livestream Publisher initialized');
});
