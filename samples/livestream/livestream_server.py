#!/usr/bin/env python3
"""
WebTransport Livestream Server
Simple multi-user livestream application using WebTransport over HTTP/3.

Architecture:
- Publisher connects to /publish/{stream_id}
- Viewers connect to /watch/{stream_id}
- Each stream has 1 publisher, multiple viewers
- Frames are buffered (30 frames) and broadcast to all viewers
"""

import asyncio
import argparse
import logging
import sys
from collections import defaultdict, deque
from urllib.parse import urlparse

from aioquic.asyncio import serve
from aioquic.quic.configuration import QuicConfiguration
from aioquic.h3.connection import H3_ALPN
from aioquic.asyncio.protocol import QuicConnectionProtocol
from aioquic.h3.connection import H3Connection
from aioquic.h3.events import (
    H3Event,
    HeadersReceived,
    DataReceived,
    WebTransportStreamDataReceived,
    DatagramReceived # Thêm DatagramReceived
)
from aioquic.quic.events import QuicEvent, ProtocolNegotiated, StreamReset


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('livestream')
logger.setLevel(logging.INFO)


class LiveStream:
    """Represents a single livestream channel"""
    
    def __init__(self, stream_id):
        self.stream_id = stream_id
        self.publisher = None
        self.viewers = set()
        # self.frame_buffer = deque(maxlen=30)  # Keep last 30 frames
        # self.last_keyframe_idx = None
        # self.frame_count = 0
        
        logger.info(f"Created stream: {stream_id}")
    
    def set_publisher(self, handler):
        """Set the publisher for this stream"""
        if self.publisher:
            logger.warning(f"Stream {self.stream_id} already has a publisher, replacing")
        
        self.publisher = handler
        logger.info(f"Publisher connected to stream: {self.stream_id}")
    
    def add_viewer(self, handler):
        """Add a viewer to this stream"""
        self.viewers.add(handler)
        logger.info(f"Viewer connected to stream: {self.stream_id} (total viewers: {len(self.viewers)})")
    
    def remove_viewer(self, handler):
        """Remove a viewer from this stream"""
        self.viewers.discard(handler)
        logger.info(f"Viewer disconnected from stream: {self.stream_id} (remaining: {len(self.viewers)})")
    
    # def add_frame(self, frame_data, is_keyframe):
    #     """Add a frame to the buffer"""
    #     self.frame_buffer.append((frame_data, is_keyframe))
        
    #     if is_keyframe:
    #         self.last_keyframe_idx = len(self.frame_buffer) - 1
        
    #     self.frame_count += 1
    
    # def get_frames_from_keyframe(self):
    #     """Get all frames from the last keyframe onwards"""
    #     if self.last_keyframe_idx is None:
    #         return list(self.frame_buffer)
        
    #     # Return frames from last keyframe
    #     return list(self.frame_buffer)[self.last_keyframe_idx:]
    
    # async def broadcast_frame(self, frame_data):
    #     """Broadcast a frame to all viewers"""
    #     if not self.viewers:
    #         return
        
    #     # Send to all viewers in parallel
    #     tasks = [viewer.send_frame(frame_data) for viewer in self.viewers]
    #     await asyncio.gather(*tasks, return_exceptions=True)

    # --- Thay đổi: broadcast_datagram ---
    async def broadcast_datagram(self, datagram_data):
        """Broadcast a datagram fragment to all viewers"""
        if not self.viewers:
            return
        
        # Gửi datagram song song tới tất cả viewer
        tasks = [viewer.send_datagram(datagram_data) for viewer in self.viewers]
        await asyncio.gather(*tasks, return_exceptions=True)


class StreamManager:
    """Manages all active livestreams"""
    
    def __init__(self):
        self.streams = {}
        self.lock = asyncio.Lock()
        ''' Đây là một khóa bất đồng bộ. Nó đảm bảo rằng chỉ có một tác vụ được phép đọc hoặc ghi vào self.streams 
        tại một thời điểm (vì nhiều Publisher hoặc Viewer có thể cố gắng truy cập cùng một kênh cùng lúc). '''
    
    async def get_stream(self, stream_id, create=True):
        """Get or create a stream"""
        async with self.lock:
            if stream_id not in self.streams and create:
                self.streams[stream_id] = LiveStream(stream_id)
            
            return self.streams.get(stream_id)
    
    async def remove_stream_if_empty(self, stream_id):
        """Remove stream if it has no publisher and no viewers"""
        async with self.lock:
            stream = self.streams.get(stream_id)
            if stream and not stream.publisher and not stream.viewers:
                del self.streams[stream_id]
                logger.info(f"Removed empty stream: {stream_id}")


# Global stream manager
stream_manager = StreamManager()


class PublisherHandler:
    """Handles a publisher connection"""
    
    def __init__(self, stream_id, session_id, http, protocol):
        self.stream_id = stream_id
        self.session_id = session_id  # WebTransport session ID (QUIC stream ID)
        self.http = http  # H3Connection
        self.protocol = protocol
        self.stream_buffers = {}  # stream_id -> bytearray buffer
        self.active = True
        
    async def handle(self):
        """Handle publisher session"""
        # Register as publisher
        stream = await stream_manager.get_stream(self.stream_id)
        stream.set_publisher(self)
        
        logger.info(f"Publisher handler started for stream: {self.stream_id}")
        
        try:
            # Process incoming unidirectional streams
            while self.active:
                # Check for incoming streams via HTTP/3
                await asyncio.sleep(0.1)
                
        except asyncio.CancelledError:
            logger.info(f"Publisher disconnected from stream: {self.stream_id}")
        finally:
            # Cleanup
            stream.publisher = None
            await stream_manager.remove_stream_if_empty(self.stream_id)
    
    # async def handle_stream_data(self, wt_stream_id, data, end_stream):
    #     """Handle incoming frame data from publisher"""
    #     # Buffer data from this stream
    #     if wt_stream_id not in self.stream_buffers:
    #         self.stream_buffers[wt_stream_id] = bytearray()
        
    #     self.stream_buffers[wt_stream_id].extend(data)
        
    #     # Process complete frame when stream ends
    #     if end_stream:
    #         frame_data = bytes(self.stream_buffers[wt_stream_id])
    #         del self.stream_buffers[wt_stream_id]
            
    #         stream = await stream_manager.get_stream(self.stream_id, create=False)
    #         if not stream:
    #             return
            
    #         # Parse frame header
    #         if len(frame_data) < 16:
    #             logger.warning(f"Received invalid frame data (too short: {len(frame_data)} bytes)")
    #             return
            
    #         # Extract keyframe flag (byte 12)
    #         is_keyframe = (frame_data[12] == 1)
            
    #         # Store frame in buffer
    #         stream.add_frame(frame_data, is_keyframe)
            
    #         # Broadcast to viewers
    #         await stream.broadcast_frame(frame_data)
            
    #         if stream.frame_count % 30 == 0:  # Log every 30 frames
    #             logger.info(f"Stream {self.stream_id}: {stream.frame_count} frames processed (keyframe: {is_keyframe})")

    # --- Thay đổi: Xử lý Datagram ---
    async def h3_event_received(self, event: H3Event):
        """Handle incoming datagrams from publisher"""
        if isinstance(event, DatagramReceived):
            stream = await stream_manager.get_stream(self.stream_id, create=False)
            if stream:
                # Chỉ chuyển tiếp (relay) datagram
                await stream.broadcast_datagram(event.data)


# class ViewerHandler:
#     """Handles a viewer connection"""
    
#     def __init__(self, stream_id, session_id, http, protocol):
#         self.stream_id = stream_id
#         self.session_id = session_id  # WebTransport session ID (QUIC stream ID)
#         self.http = http  # H3Connection
#         self.protocol = protocol
#         self.active = True
        
#     async def handle(self):
#         """Handle viewer session"""
#         # Get stream
#         stream = await stream_manager.get_stream(self.stream_id, create=False)
        
#         if not stream:
#             logger.warning(f"Stream not found: {self.stream_id}")
#             return
        
#         # Add viewer
#         stream.add_viewer(self)
        
#         # Send buffered frames from last keyframe
#         buffered_frames = stream.get_frames_from_keyframe()
#         logger.info(f"Sending {len(buffered_frames)} buffered frames to viewer")
#         for idx, (frame_data, is_keyframe) in enumerate(buffered_frames):
#             await self.send_frame(frame_data)
#             logger.info(f"Sent buffered frame {idx+1}/{len(buffered_frames)} (keyframe: {is_keyframe}, size: {len(frame_data)})")
#             # Small delay to avoid overwhelming the connection
#             await asyncio.sleep(0.01)
        
#         try:
#             # Keep connection alive
#             while self.active:
#                 await asyncio.sleep(1)
                
#         except asyncio.CancelledError:
#             logger.info(f"Viewer disconnected from stream: {self.stream_id}")
#         finally:
#             # Cleanup
#             stream.remove_viewer(self)
#             await stream_manager.remove_stream_if_empty(self.stream_id)
    
#     async def send_frame(self, frame_data):
#         """Send a frame to this viewer"""
#         if not self.active:
#             return
        
#         try:
#             # Create unidirectional WebTransport stream
#             stream_id = self.http.create_webtransport_stream(
#                 self.session_id, is_unidirectional=True
#             )
            
#             # Send frame data
#             self.protocol._quic.send_stream_data(stream_id, frame_data, end_stream=True)
#             self.protocol.transmit()
            
#             logger.debug(f"Sent frame to viewer (stream: {self.stream_id}, size: {len(frame_data)} bytes)")
            
#         except Exception as e:
#             logger.error(f"Error sending frame to viewer: {e}")
#             self.active = False


class ViewerHandler:
    """Handles a viewer connection"""
    
    def __init__(self, stream_id, session_id, http, protocol):
        self.stream_id = stream_id
        self.session_id = session_id
        self.http = http
        self.protocol = protocol
        self.active = True
        
    async def handle(self):
        """Handle viewer session"""
        stream = await stream_manager.get_stream(self.stream_id, create=False)
        
        if not stream:
            logger.warning(f"Stream not found: {self.stream_id}")
            return
        
        stream.add_viewer(self)
        
        # --- Bỏ logic Gửi Frame đệm ---
        # Người xem mới sẽ phải chờ Keyframe tiếp theo
        
        try:
            # Giữ kết nối mở
            while self.active:
                await asyncio.sleep(1)
        except asyncio.CancelledError:
            logger.info(f"Viewer disconnected from stream: {self.stream_id}")
        finally:
            # Cleanup
            if stream:
                stream.remove_viewer(self)
                await stream_manager.remove_stream_if_empty(self.stream_id)
    
    # --- Thay đổi: send_datagram ---
    async def send_datagram(self, datagram_data):
        """Send a datagram fragment to this viewer"""
        if not self.active:
            return
        
        try:
            # Gửi datagram qua session chính
            self.http.send_datagram(
                self.session_id,
                datagram_data
            )
            self.protocol.transmit()
        except Exception as e:
            logger.error(f"Error sending datagram to viewer: {e}")
            self.active = False


class LivestreamProtocol(QuicConnectionProtocol):
    """WebTransport protocol handler"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._http = None
        self.handlers = {}  # stream_id -> handler
    
    def quic_event_received(self, event: QuicEvent):
        """Handle QUIC events"""
        # Initialize HTTP/3 connection when protocol is negotiated
        if isinstance(event, ProtocolNegotiated):
            self._http = H3Connection(self._quic, enable_webtransport=True)
        
        # Handle stream resets
        elif isinstance(event, StreamReset):
            if event.stream_id in self.handlers:
                handler = self.handlers[event.stream_id]
                if hasattr(handler, 'active'):
                    handler.active = False
        
        # Handle HTTP/3 events
        # if self._http is not None:
        #     for h3_event in self._http.handle_event(event):
        #         self._h3_event_received(h3_event)

        if self._http is not None:
            for h3_event in self._http.handle_event(event):
                # Sử dụng asyncio.create_task để gọi hàm async
                asyncio.create_task(self._h3_event_received(h3_event))
    
    # def _h3_event_received(self, event: H3Event):
    #     """Handle HTTP/3 events"""
        
    #     if isinstance(event, HeadersReceived):
    #         # Parse request path
    #         headers = dict(event.headers)
    #         path = headers.get(b':path', b'').decode('utf-8')
    #         method = headers.get(b':method', b'').decode('utf-8')
    #         protocol = headers.get(b':protocol', b'').decode('utf-8')
            
    #         logger.info(f"Received request: {method} {path} (protocol: {protocol})")
            
    #         # Check if it's a WebTransport CONNECT request
    #         if method != 'CONNECT' or protocol != 'webtransport':
    #             logger.warning(f"Invalid WebTransport request")
    #             self._send_response(event.stream_id, 400, end_stream=True)
    #             return
            
    #         # Route request
    #         if path.startswith('/publish/'):
    #             stream_id = path[9:]  # Remove '/publish/' prefix
    #             handler = PublisherHandler(stream_id, event.stream_id, self._http, self)
    #             self.handlers[event.stream_id] = handler
    #             logger.info(f"Created PublisherHandler: stream_id={stream_id}, session_id={event.stream_id}")
    #             self._send_response(event.stream_id, 200)  # Accept WebTransport session
    #             asyncio.create_task(handler.handle())
                
    #         elif path.startswith('/watch/'):
    #             stream_id = path[7:]  # Remove '/watch/' prefix
    #             handler = ViewerHandler(stream_id, event.stream_id, self._http, self)
    #             self.handlers[event.stream_id] = handler
    #             logger.info(f"Created ViewerHandler: stream_id={stream_id}, session_id={event.stream_id}")
    #             self._send_response(event.stream_id, 200)  # Accept WebTransport session
    #             asyncio.create_task(handler.handle())
                
    #         else:
    #             logger.warning(f"Unknown path: {path}")
    #             self._send_response(event.stream_id, 404, end_stream=True)
        
    #     elif isinstance(event, WebTransportStreamDataReceived):
    #         # Handle incoming stream data (frames from publisher)
    #         logger.debug(f"Received WebTransport stream data: session={event.session_id}, stream={event.stream_id}, size={len(event.data)}, ended={event.stream_ended}")
            
    #         handler = self.handlers.get(event.session_id)
            
    #         if isinstance(handler, PublisherHandler):
    #             asyncio.create_task(
    #                 handler.handle_stream_data(event.stream_id, event.data, event.stream_ended)
    #             )
    #         else:
    #             logger.warning(f"No publisher handler for session {event.session_id}")
    
    # def _send_response(self, stream_id: int, status_code: int, end_stream=False):
    #     """Send HTTP response"""
    #     headers = [
    #         (b":status", str(status_code).encode()),
    #     ]
    #     if status_code == 200:
    #         headers.append((b"sec-webtransport-http3-draft", b"draft02"))
        
    #     self._http.send_headers(stream_id=stream_id, headers=headers, end_stream=end_stream)
    #     self.transmit()  # Ensure data is sent

    # --- Thay đổi: Hàm này giờ là async ---
    async def _h3_event_received(self, event: H3Event):
        """Handle HTTP/3 events"""
        
        if isinstance(event, HeadersReceived):
            # ... (Giữ nguyên logic HeadersReceived để tạo Publisher/Viewer Handlers) ...
            headers = dict(event.headers)
            path = headers.get(b':path', b'').decode('utf-8')
            method = headers.get(b':method', b'').decode('utf-8')
            protocol = headers.get(b':protocol', b'').decode('utf-8')
            
            logger.info(f"Received request: {method} {path} (protocol: {protocol})")
            
            if method != 'CONNECT' or protocol != 'webtransport':
                logger.warning(f"Invalid WebTransport request")
                self._send_response(event.stream_id, 400, end_stream=True)
                return
            
            if path.startswith('/publish/'):
                stream_id = path[9:]
                handler = PublisherHandler(stream_id, event.stream_id, self._http, self)
                self.handlers[event.stream_id] = handler
                logger.info(f"Created PublisherHandler: stream_id={stream_id}, session_id={event.stream_id}")
                self._send_response(event.stream_id, 200)
                asyncio.create_task(handler.handle())
                
            elif path.startswith('/watch/'):
                stream_id = path[7:]
                handler = ViewerHandler(stream_id, event.stream_id, self._http, self)
                self.handlers[event.stream_id] = handler
                logger.info(f"Created ViewerHandler: stream_id={stream_id}, session_id={event.stream_id}")
                self._send_response(event.stream_id, 200)
                asyncio.create_task(handler.handle())
                
            else:
                logger.warning(f"Unknown path: {path}")
                self._send_response(event.stream_id, 404, end_stream=True)

        # --- Thay đổi: Xử lý Datagram ---
        elif isinstance(event, DatagramReceived):
            # handler = self.handlers.get(event.session_id)
            handler = self.handlers.get(event.stream_id)
            
            if isinstance(handler, PublisherHandler):
                # Chuyển datagram cho PublisherHandler (vì nó là async)
                await handler.h3_event_received(event)
            else:
                logger.warning(f"Received datagram for non-publisher session {event.session_id}")
        
        # --- Bỏ logic WebTransportStreamDataReceived ---
        # elif isinstance(event, WebTransportStreamDataReceived):
        #      logger.warning(f"Received unexpected Stream data on session {event.session_id}")
    
    def _send_response(self, stream_id: int, status_code: int, end_stream=False):
        # ... (Giữ nguyên hàm _send_response) ...
        headers = [
            (b":status", str(status_code).encode()),
        ]
        if status_code == 200:
            headers.append((b"sec-webtransport-http3-draft", b"draft02"))
        
        self._http.send_headers(stream_id=stream_id, headers=headers, end_stream=end_stream)
        self.transmit()


def load_certificate_from_echo(cert_file='../echo/cert.crt', key_file='../echo/key.key'):
    """Load certificate from echo directory"""
    import os
    
    # Resolve paths relative to this script
    script_dir = os.path.dirname(os.path.abspath(__file__))
    cert_path = os.path.join(script_dir, cert_file)
    key_path = os.path.join(script_dir, key_file)
    
    if not os.path.exists(cert_path):
        logger.error(f"Certificate file not found: {cert_path}")
        sys.exit(1)
    
    if not os.path.exists(key_path):
        logger.error(f"Key file not found: {key_path}")
        sys.exit(1)
    
    logger.info(f"Loading certificate from {cert_path}")
    logger.info(f"Loading key from {key_path}")
    
    with open(cert_path, 'r') as f:
        cert_pem = f.read()
    
    with open(key_path, 'r') as f:
        key_pem = f.read()
    
    # Calculate SPKI hash for Chrome flags
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives import serialization
    import hashlib
    
    cert = x509.load_pem_x509_certificate(cert_pem.encode(), default_backend())
    public_key = cert.public_key()
    public_key_der = public_key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    )
    spki_hash = hashlib.sha256(public_key_der).digest()
    
    return {
        'cert_path': cert_path,
        'key_path': key_path,
        'spki_hash_hex': spki_hash.hex()
    }


async def main(host='127.0.0.1', port=4433):
    """Main server function"""
    
    logger.info("=" * 70)
    logger.info("WebTransport Livestream Server")
    logger.info("=" * 70)
    
    # Load certificate from echo directory
    cert_data = load_certificate_from_echo()
    
    # Configure QUIC
    configuration = QuicConfiguration(
        alpn_protocols=H3_ALPN,
        is_client=False,
        max_datagram_frame_size=65536,
    )
    
    # Load certificate from echo directory
    configuration.load_cert_chain(certfile=cert_data['cert_path'], keyfile=cert_data['key_path'])
    
    # Start server
    logger.info(f"\n Server starting on {host}:{port}")
    logger.info(f" SPKI Hash: {cert_data['spki_hash_hex']}")
    logger.info(f"\n Launch Chrome with:")
    logger.info(f'   --origin-to-force-quic-on={host}:{port} \\')
    logger.info(f'   --ignore-certificate-errors-spki-list={cert_data["spki_hash_hex"]}\n')
    logger.info(f"Publisher URL: https://{host}:{port}/publish/YOUR_STREAM_ID")
    logger.info(f"Viewer URL: https://{host}:{port}/watch/YOUR_STREAM_ID")
    logger.info("=" * 70)
    
    #aioquic.asyncio.serve()
    await serve(
        host=host,
        port=port,
        configuration=configuration,
        create_protocol=LivestreamProtocol,
    )
    
    # Keep server running
    await asyncio.Future()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='WebTransport Livestream Server')
    parser.add_argument('--host', type=str, default='127.0.0.1', help='Host to bind')
    parser.add_argument('--port', type=int, default=4433, help='Port to bind')
    
    args = parser.parse_args()
    
    try:
        asyncio.run(main(host=args.host, port=args.port))
    except KeyboardInterrupt:
        logger.info("\n Server stopped by user")
