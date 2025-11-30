# Sora2 Automation System

Hệ thống tự động hóa tạo video Sora với kiến trúc microservices, bao gồm:

- **sora-worker**: Service worker chạy trực tiếp trên Windows để thực hiện generation
- **orchestrator**: Service điều phối nhận task từ API server, chọn account, và spawn worker processes
- **credit-updater**: Service cập nhật credit hàng ngày cho tất cả profiles
- **monitor-gateway**: Service realtime view-only nhận stream từ worker

## Kiến trúc

```
┌─────────────────┐
│  API Server     │ (media.yofatik.ai)
│  (Task Queue)   │
└────────┬────────┘
         │
         │ GET /tasks/{code}
         │ PUT /tasks/{id}
         ▼
┌─────────────────┐
│  Orchestrator   │ ← MongoDB (profiles, proxies)
│  Service        │
└────────┬────────┘
         │
         │ spawn node sora-worker/dist/index.js
         ▼
┌─────────────────┐
│  Sora Worker    │ (Playwright) 
└────────┬────────┘
         │
         │ POST /frames (JPEG stream)
         ▼
┌─────────────────┐
│ Monitor Gateway │ → dashboard view-only
└─────────────────┘
```

## Cài đặt

### 1. Cài đặt dependencies

```powershell
# Sora Worker
cd sora-worker
npm install

# Orchestrator
cd ../orchestrator
npm install

# Credit Updater
cd ../credit-updater
npm install

# Monitor Gateway
cd ../monitor-gateway
npm install
```

### 2. Cấu hình MongoDB

Tạo file `.env` từ `.env.example` và điền các giá trị:

```powershell
cp .env.example .env
```

Hoặc chạy MongoDB bằng Docker:

```powershell
docker-compose up -d mongodb
```

### 3. Build worker (TypeScript → dist)

```powershell
cd sora-worker
npm run build
```

## Sử dụng

### 1. Setup profiles (lần đầu)

Để setup một profile mới và login:

```powershell
cd sora-worker
npm start -- --profile acc01 --prompt "test" --duration 10 --orientation portrait --manual-login --login-only
```

Browser sẽ mở, bạn login tay vào Sora. Sau khi login xong, nhấn Enter trong terminal để lưu session.

### 2. Chạy Orchestrator

Orchestrator sẽ tự động:
- Claim task từ API server
- Chọn profile có credit >= 5 và ít dùng nhất
- Spawn tiến trình Node của `sora-worker`
- Stream session về monitor-gateway và update result về server

```powershell
cd orchestrator
npm start
```

### 3. Chạy Monitor Gateway

```powershell
cd monitor-gateway
npm start
```

Service này expose:
- `POST /frames`: Worker push từng frame JPEG (đã cấu hình tự động từ orchestrator)
- `GET /tasks`: Danh sách task đang stream
- `GET /stream/:taskId`: SSE, dashboard sẽ sử dụng endpoint này
- `GET /`: Trang HTML đơn giản để xem realtime (view-only)

### 4. Chạy Credit Updater (tùy chọn)

Service này sẽ chạy mỗi 24h để update credit cho tất cả profiles:

```powershell
cd credit-updater
npm start
```

Hoặc setup Windows Task Scheduler để chạy định kỳ.

## Cấu trúc MongoDB

### Collection: `profiles`

```typescript
{
  name: string;                    // Profile name (e.g., "acc01")
  proxy: string;                   // HTTP proxy URL
  userDataDir: string;             // Path to profile directory
  fingerprint: string | null;       // Bablosoft fingerprint ID
  status: 'active' | 'blocked' | 'low_credit' | 'disabled';
  creditRemaining: number | null;  // Sora credits remaining
  dailyRunCount: number;           // Number of runs today
  lastRunAt: string | null;        // ISO timestamp
  lastCreditCheckAt: string | null; // ISO timestamp
  createdAt: string;
  updatedAt: string;
}
```

### Collection: `proxies`

```typescript
{
  proxy: string;                   // HTTP proxy URL (unique)
  assignedProfile: string | null;  // Profile name if assigned
  addedAt: string;                  // ISO timestamp
}
```

## Environment Variables

Tất cả services đọc `.env` ở project root:

- `MONGODB_URI`, `MONGODB_DATABASE`
- `API_KEY` hoặc `TOOL_API_KEY`
- `BABLOSOFT_API_KEY`
- `PROFILE_ROOT`: đường dẫn tuyệt đối tới thư mục profiles (ví dụ `C:\sora2\profiles`)
- `FINGERPRINT_WORKDIR`: đường dẫn tuyệt đối tới `.fingerprint-engine`
- `WORKER_ENTRY` (optional): override đường dẫn tới `dist/index.js`
- `MONITOR_GATEWAY_URL`, `MONITOR_GATEWAY_TOKEN`, `MONITOR_CAPTURE_INTERVAL_MS`
- `MONITOR_GATEWAY_PORT`, `MONITOR_GATEWAY_HOST`, `MONITOR_ARTIFACTS_DIR`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional)

## Troubleshooting

### Worker process không chạy được

- Đảm bảo đã build `sora-worker` (`dist/index.js` tồn tại)
- Kiểm tra biến môi trường `PROFILE_ROOT`, `FINGERPRINT_WORKDIR`, `BABLOSOFT_API_KEY`
- Xem log orchestrator để lấy stdout/stderr của worker

### Không có profile available

- Kiểm tra MongoDB có profiles với `status: 'active'` và `creditRemaining >= 5`
- Chạy credit-updater để update credit
- Tạo profile mới bằng cách login tay

### Task timeout

- Mặc định timeout là 25 phút
- Có thể tăng trong `.env`: `TASK_TIMEOUT_MINUTES=30`

## Development

### Build TypeScript

```powershell
cd sora-worker
npm run build

cd ../orchestrator
npm run build

cd ../credit-updater
npm run build
```

### Watch mode

```powershell
cd sora-worker
npm run dev
```

## Notes

- **Login flow**: Vẫn giữ manual login. Orchestrator không tự login, chỉ dùng profiles đã setup sẵn.
- **Windows requirement**: Fingerprint engine yêu cầu Windows, nên worker phải chạy trên Windows hoặc Windows container.
- **Profile persistence**: Tất cả cookies/sessions lưu trong `profiles/<name>/Default/`, worker dùng trực tiếp thư mục này khi spawn process.
∑