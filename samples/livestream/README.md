# 🎥 WebTransport Livestream Application

Ứng dụng livestream đơn giản sử dụng WebTransport, WebCodecs và HTTP/3.

## 📋 Tính năng

- ✅ Livestream video realtime với độ trễ cực thấp (< 500ms)
- ✅ Hỗ trợ nhiều người xem cùng lúc
- ✅ Sử dụng chứng chỉ SSL có sẵn từ thư mục echo
- ✅ Sử dụng WebCodecs API (VP8/VP9/H264/AV1)
- ✅ Buffer thông minh với keyframe sync
- ✅ Giao diện đẹp, thống kê realtime

## 🚀 Cài đặt

### 1. Cài đặt Python packages

```powershell
pip install aioquic cryptography
```

### 2. Cấu trúc thư mục

```
samples/livestream/
├── livestream_server.py      # Server Python
├── publisher.html            # Giao diện Publisher
├── viewer.html               # Giao diện Viewer
└── js/
    ├── livestream_publisher.js
    └── livestream_viewer.js

samples/echo/
├── cert.crt                  # Certificate (sử dụng bởi server)
└── key.key                   # Private key (sử dụng bởi server)
```

## 🎬 Hướng dẫn sử dụng

### Bước 0: Tạo certificate trong thư mục echo (nếu chưa có)

```powershell
cd "d:\Year4_Semester 1\LTM\BTL\webtransport\samples\echo\py-server"
python mkcert.py
# Copy cert.crt và key.key vào thư mục echo
```

**Hoặc** sử dụng certificate có sẵn từ echo server.

### Bước 1: Chạy Server

```powershell
cd "d:\Year4_Semester 1\LTM\BTL\webtransport\samples\livestream"
python livestream_server.py
```

Server sẽ khởi động và hiển thị:
```
🚀 Server starting on localhost:4433
📜 SPKI Hash: abc123def456...
📌 Launch Chrome with:
   --origin-to-force-quic-on=localhost:4433 \
   --ignore-certificate-errors-spki-list=abc123def456...

📺 Publisher URL: https://localhost:4433/publish/YOUR_STREAM_ID
👀 Viewer URL: https://localhost:4433/watch/YOUR_STREAM_ID
```

**Quan trọng**: Copy dòng lệnh Chrome để sử dụng ở bước 2!

### Bước 2: Mở Chrome với Flags

**Đóng TẤT CẢ cửa sổ Chrome trước!** (Kiểm tra Task Manager)

```powershell
# Thay {SPKI_HASH} bằng hash từ server
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --origin-to-force-quic-on=localhost:4433 `
  --ignore-certificate-errors-spki-list={SPKI_HASH}
```

### Bước 3: Mở Publisher (Streamer)

1. Truy cập: `file:///d:/Year4_Semester 1/LTM/BTL/webtransport/samples/livestream/publisher.html`
2. Cấu hình:
   - **Server URL**: `https://localhost:4433/publish/my-stream`
   - **Codec**: VP8 (khuyến nghị)
   - **Bitrate**: 1000000 (1 Mbps)
   - **Frame Rate**: 30 fps
3. Click **START STREAMING**
4. Cho phép truy cập camera
5. Copy link Viewer để chia sẻ

### Bước 4: Mở Viewer (Người xem)

1. Truy cập: `file:///d:/Year4_Semester 1/LTM/BTL/webtransport/samples/livestream/viewer.html`
2. Nhập **Server URL**: `https://localhost:4433/watch/my-stream`
3. Click **CONNECT TO STREAM**
4. Xem video realtime!

## 📊 Thống kê hiển thị

### Publisher (Streamer)
- **Frames Sent**: Số frame đã gửi
- **KB Sent**: Tổng dung lượng đã gửi
- **FPS**: Frame rate hiện tại
- **Duration**: Thời gian stream

### Viewer (Người xem)
- **Frames Received**: Số frame nhận được
- **KB Received**: Dung lượng nhận được
- **FPS**: Frame rate hiện tại
- **Latency**: Độ trễ (ms)
- **Buffer Size**: Số frame trong buffer
- **Dropped Frames**: Frame bị drop

## ⚙️ Cấu hình nâng cao

### Thay đổi Codec

Publisher hỗ trợ nhiều codec:
- **VP8**: Tương thích tốt nhất
- **VP9**: Chất lượng cao hơn
- **H.264**: Hỗ trợ hardware encoding
- **AV1**: Nén tốt nhất (cần Chrome mới)

### Thay đổi Stream ID

Publisher và Viewer phải dùng **cùng Stream ID**:
- Publisher: `https://localhost:4433/publish/YOUR_STREAM_ID`
- Viewer: `https://localhost:4433/watch/YOUR_STREAM_ID`

### Nhiều stream cùng lúc

Server hỗ trợ nhiều stream song song:
- Stream 1: `/publish/gaming` và `/watch/gaming`
- Stream 2: `/publish/cooking` và `/watch/cooking`
- Stream 3: `/publish/music` và `/watch/music`

## 🔧 Troubleshooting

### ❌ "Failed to connect"

**Nguyên nhân**: Chrome chưa được khởi động với flags đúng

**Giải pháp**:
1. Đóng TẤT CẢ Chrome windows (kiểm tra Task Manager)
2. Khởi động lại Chrome với flags từ server
3. Kiểm tra SPKI hash khớp với server

### ❌ "Camera not accessible"

**Giải pháp**:
1. Cho phép camera trong Chrome settings
2. Kiểm tra camera không bị app khác sử dụng
3. Thử reload trang

### ❌ "Stream not found"

**Nguyên nhân**: Publisher chưa kết nối hoặc Stream ID sai

**Giải pháp**:
1. Kiểm tra Publisher đã Start Streaming chưa
2. Đảm bảo Stream ID giống nhau (publisher/my-stream = watch/my-stream)
3. Kiểm tra server logs

### ❌ Độ trễ cao

**Giải pháp**:
1. Giảm bitrate (500000 = 500 Kbps)
2. Giảm resolution (640x480)
3. Giảm frame rate (15-20 fps)
4. Chọn codec VP8 thay vì VP9

## 📁 Chi tiết kiến trúc

### Server (Python)
- **LiveStream**: Quản lý 1 stream (1 publisher, N viewers)
- **StreamManager**: Quản lý tất cả streams
- **PublisherHandler**: Xử lý publisher connection
- **ViewerHandler**: Xử lý viewer connection
- **Frame Buffer**: Lưu 30 frames gần nhất + keyframe tracking

### Client (JavaScript)
- **VideoEncoder**: Encode camera frames → EncodedVideoChunk
- **VideoDecoder**: Decode chunks → VideoFrame
- **MediaStreamTrackProcessor**: Truy cập raw camera frames
- **MediaStreamTrackGenerator**: Tạo video track từ decoded frames
- **WebTransport**: Gửi/nhận frames qua unidirectional streams

### Luồng dữ liệu

```
Camera → VideoEncoder → Serialize → WebTransport → Server → Buffer
                                                              ↓
                                            Server Broadcast to Viewers
                                                              ↓
Viewer ← VideoDecoder ← Deserialize ← WebTransport ← Server Buffer
```

## 🎯 Mở rộng

### Thêm Audio
- Sử dụng AudioEncoder/AudioDecoder
- Stream audio qua WebTransport datagrams
- Sync audio/video bằng timestamps

### Thêm Chat
- Sử dụng WebTransport datagrams cho messages
- Broadcast chat từ server đến tất cả viewers

### Recording
- Lưu encoded chunks vào file
- Sử dụng MediaRecorder API
- Export sang MP4/WebM

### Adaptive Bitrate
- Monitor network stats
- Tự động giảm bitrate khi mạng yếu
- Tăng lại khi network ổn định

## 📝 Ghi chú

- Server sử dụng certificate từ `../echo/cert.crt` và `../echo/key.key`
- Certificate có hạn **14 ngày** (theo WebTransport spec)
- Sau khi certificate hết hạn, tạo lại trong thư mục echo/py-server
- Chrome flags cần khởi động lại mỗi khi có SPKI hash mới
- Không dùng trong production (chỉ để demo/học tập)

## 🌟 Demo thành công

Nếu setup đúng, bạn sẽ thấy:
- ✅ Publisher: Camera preview + "🔴 LIVE" badge
- ✅ Viewer: Video stream realtime + Quality bars
- ✅ Server logs: "Publisher connected", "Viewer connected"
- ✅ FPS ~30, Latency < 500ms

**Chúc bạn thành công! 🎉**
