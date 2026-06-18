# high-speed-scanner

高拍仪 WebSocket 模拟服务 — 用于前端无设备时的联调开发，模拟快递面单底照的实时预览与拍照捕获。

## 技术栈

- Node.js（纯 JS，无第三方图片库）
- WebSocket（ws）
- 内置 PNG 编码器 + 快递面单渲染管线

## 快速启动

```bash
npm install
node high-speed-scanner.js
```

服务监听 `ws://127.0.0.1:8082`，启动后前端即可连接。

## 项目结构

```
├── high-speed-scanner.js   # WebSocket 服务、协议路由、会话管理
├── waybill-renderer.js     # 面单底照渲染管线（6 层合成）
├── png-encoder.js          # PNG 编码器（CRC32 + zlib 压缩）
└── package.json
```

## 支持的协议指令

| 指令 | 说明 |
|------|------|
| `GetCameraInfo` | 返回模拟设备列表（2 台虚拟高拍仪） |
| `OpenCamera` | 打开指定设备，设置分辨率和帧率 |
| `GetCameraVideoBuff` | 开启/停止视频预览推送 |
| `CameraCaptureBase64` | 拍照捕获，返回高分辨率面单底照 |
| `SetCameraInfo` | 切换视频参数（mediaType / resolution） |
| `SetCameraImageInfo` | 配置图像算法（cropType / imageType） |
| `CloseCamera` | 关闭设备，停止预览 |
| `GetOcrSupportInfo` | 返回 OCR 支持语言列表 |

## 面单底照渲染管线

每帧按以下 6 层合成，模拟高拍仪拍摄快递面单的真实视觉效果：

1. **扫描台背景** — 深灰底板 + 侧光渐变
2. **纸张矩形** — 奶白色 A4 纸 + ±2°旋转 + 右下投影
3. **面单内容** — 6 套快递公司模板轮换（寄件人/收件人文字块、Code128 条形码+运单号、红色圆形印章、21×21 二维码、分隔线）
4. **纸张纹理** — 16px 网格低频亮度波动，双线性插值
5. **传感器噪点** — Box-Muller 高斯近似（预览帧强度 7，拍照帧强度 3）
6. **暗角效果** — 四角渐变压暗，模拟镜头 vignetting

### 预览帧 vs 拍照帧

| 特性 | 预览帧 | 拍照帧 |
|------|--------|--------|
| 分辨率 | 640×480 | 1280×960 |
| 纸张姿态 | ±3px 随机抖动 | 固定 |
| 噪点强度 | 中（7） | 低（3） |
| 模板切换 | 每 4 帧轮换 | 固定 |

## 可配置参数

编辑 `high-speed-scanner.js` 顶部常量：

```javascript
const PORT = 8082          // WebSocket 监听端口
const VIDEO_FPS = 5        // 预览帧率
const VIDEO_WIDTH = 640    // 预览宽度
const VIDEO_HEIGHT = 480   // 预览高度
```
