# Orchestrator Service

Service điều phối nhận task từ API server, chọn account, và quản lý worker containers.

## Environment Variables

Cần thêm vào `.env` ở root project:

```env
# API Configuration
API_BASE_URL=https://media.yofatik.ai/api/v1/tool
API_KEY=your_api_key_here
PRODUCT_CODE=sora-2-with-watermark

# MongoDB (same as other services)
MONGODB_URI=mongodb://...
MONGODB_DATABASE=sora

# Docker
DOCKER_IMAGE=sora-worker:latest
PROFILE_ROOT=profiles

# Settings
TASK_TIMEOUT_MINUTES=25
POLL_INTERVAL_SECONDS=10

# Telegram (optional)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

## Database Collections

### tasks
Lưu thông tin các task đã claim:
- `taskId`: ID từ API
- `status`: pending | claimed | processing | completed | failed | timeout
- `profileName`: Profile được assign
- `publicUrl`: URL của video khi completed
- `error`: Error message nếu failed
- Timestamps: `claimedAt`, `startedAt`, `completedAt`

### daily_stats
Tracking số lượng video gen mỗi ngày:
- `date`: YYYY-MM-DD
- `totalTasks`: Tổng số task
- `completedTasks`: Số task completed
- `failedTasks`: Số task failed
- `totalVideos`: Tổng số video đã gen

## Usage

```bash
cd orchestrator
npm start
```

Service sẽ:
1. Poll API mỗi `POLL_INTERVAL_SECONDS` giây
2. Claim task nếu có
3. Chọn profile có credit >= 5, ít dùng nhất
4. Chạy Docker container để generate
5. Update result về server và database


