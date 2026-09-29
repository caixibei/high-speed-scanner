# high-speed-scanner

[![License](https://img.shields.io/github/license/caixibei/high-speed-scanner)](https://github.com/caixibei/high-speed-scanner/blob/main/LICENSE)
[![Stars](https://img.shields.io/github/stars/caixibei/high-speed-scanner)](https://github.com/caixibei/high-speed-scanner/stargazers)
[![Forks](https://img.shields.io/github/forks/caixibei/high-speed-scanner)](https://github.com/caixibei/high-speed-scanner/network/members)
[![Issues](https://img.shields.io/github/issues/caixibei/high-speed-scanner)](https://github.com/caixibei/high-speed-scanner/issues)
[![Node](https://img.shields.io/badge/node-%3E%3D10-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
![Protocol](https://img.shields.io/badge/protocol-WebSocket-black)

高拍仪 WebSocket 模拟服务 — 在没有真实高拍仪硬件的电脑上，模拟高拍仪桌面端程序对外提供的 WebSocket 协议，供 bp-lims 等前端联调「高拍仪拍照」功能：设备发现、实时预览、拍照取图、关闭设备，全流程可用。

## 效果预览

前端接入后打开高拍仪弹窗的实际效果（左：定时推送的模拟预览帧与已拍缩略图；右：设备 / 视频格式 / 分辨率下拉与拍照按钮）：

![高拍仪弹窗预览](docs/preview-dialog.png)

## 工作原理

```text
浏览器前端（高拍仪弹窗组件）
        │  WebSocket（JSON 文本帧）
        ▼
ws://127.0.0.1:8082   ← 本服务（high-speed-scanner.js）
        │  按 VIDEO_FPS 定时推送预览帧
        ▼
waybill-renderer.js（合成模拟面单底照）→ png-encoder.js（纯 JS 编码 PNG）
```

- **协议**：JSON 文本帧，请求携带 `func`（指令名）与 `reqId`（请求 ID，响应原样返回）；响应携带 `result`（`0` 成功）。
- **预览流**：`GetCameraVideoBuff` 开启后，服务按 `VIDEO_FPS`（默认 5 fps）定时推送 PNG base64 帧。
- **画面**：程序合成的模拟面单底照（背景、纸张、面单内容、纸张纹理、传感器噪点、暗角 6 层），无任何真实摄像设备依赖。

## 快速开始

```bash
npm install
node high-speed-scanner.js
```

- 服务监听 `ws://127.0.0.1:8082`，控制台出现「高拍仪 WebSocket 模拟服务已启动」即启动成功。
- 前端打开高拍仪弹窗，设备下拉出现「模拟高拍仪-1 (USB 2.0)」即为接通。
- 环境要求：Node.js ≥ 10，无其他系统依赖。

## 前端接入（以 bp-lims 实际用法为准）

### 1. 配置连接地址

前端通过环境变量读取服务地址，在 `hussar-front/.env.*` 中配置：

```bash
VUE_APP_HIGH_SPEED_SCANNER_URL=ws://127.0.0.1:8082
```

test / production 环境均为本机 `8082`；development 若指向联调穿透地址，本地联调时改回 `ws://127.0.0.1:8082`。修改 `.env` 后需重启前端服务才生效。

组件读取位置：`hussar-front/src/components/highSpeedCamera/index.vue` 的 `connectServer()`，即 `new WebSocket(process.env.VUE_APP_HIGH_SPEED_SCANNER_URL)`。

### 2. 使用高拍仪公共组件（推荐）

直接复用 bp-lims 公共组件 `hussar-front/src/components/highSpeedCamera/index.vue`：

- 弹窗打开即自动建连并拉取设备列表；建连失败提示「未连接websocket服务器，请确保已运行服务端!」。
- props：`visible`（弹窗显隐）、`existingPictureIds`（已有附件 ID，逗号分隔，用于回显）、`limit`（最多可选张数）。
- 事件：`confirm`（参数为已上传附件 ID 的逗号串，图片由组件上传至 `/attachment/uploadfilewithdrag`）、`cancel`。
- 页面上仅需一个按钮控制 `visible`，弹窗内完成：选设备 / 格式 / 分辨率 → 拍照 → 勾选缩略图 → 确认。

### 3. 组件与服务的完整交互时序

| 步骤 | 前端发送 | 服务响应 / 推送 | 前端处理 |
|------|----------|------------------|----------|
| ① 建连 | `new WebSocket(VUE_APP_HIGH_SPEED_SCANNER_URL)` | — | `onopen` 后补发未发出的消息 |
| ② 取设备列表 | `{"func":"GetCameraInfo","reqId":"..."}` | `result:0` + `devInfo[]` | 渲染设备 / 格式 / 分辨率三个下拉 |
| ③ 打开设备 | `{"func":"OpenCamera","reqId":"...","devNum":0,"mediaNum":0,"resolutionNum":0,"fps":5}` | `result:0` | — |
| ④ 开启预览 | `{"func":"GetCameraVideoBuff","reqId":"...","devNum":0,"enable":"true"}` | 每 200ms 推一帧：`{func:"GetCameraVideoBuff",result:0,devNum,mime:"image/png",imgBase64Str,width:640,height:480}` | base64 显示到预览 `<img>` |
| ⑤ 拍照 | `{"func":"CameraCaptureBase64","reqId":"..."}` | `{func:"CameraCaptureBase64",result:0,mime,imgBase64Str,width,height}` | 加入已拍缩略图列表 |
| ⑥ 切换设备/格式/分辨率 | 先 `{"func":"CloseCamera","reqId":"...","devNum":0}`，再重复 ③④ | `result:0` | 刷新下拉并重开预览 |
| ⑦ 关闭弹窗 | `{"func":"CloseCamera","reqId":"...","devNum":0}` | `result:0` | 服务端停止推帧 |

注：部分低代码生成页面（如 `csmk/ym1.vue`）拍照发送的是 `{"func":"CameraCapture","reqId":"...","devNum":N,"mode":"base64"}` 变体；公共组件统一使用 `CameraCaptureBase64`。

### 4. 不依赖组件的最小接入示例

```js
const ws = new WebSocket('ws://127.0.0.1:8082')
let reqId = Date.now()

ws.onopen = () => {
  ws.send(JSON.stringify({ func: 'GetCameraInfo', reqId: String(reqId) }))
}

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.result !== 0 && msg.result !== 9) {   // 0/9 均按正常处理
    console.error(msg.func, msg.errorMsg)
    return
  }
  switch (msg.func) {
    case 'GetCameraInfo': {                     // ② 取第一台模拟设备并开预览
      const dev = msg.devInfo[0]
      ws.send(JSON.stringify({ func: 'OpenCamera', reqId: String(++reqId), devNum: dev.id, mediaNum: 0, resolutionNum: 0, fps: 5 }))
      ws.send(JSON.stringify({ func: 'GetCameraVideoBuff', reqId: String(++reqId), devNum: dev.id, enable: 'true' }))
      break
    }
    case 'GetCameraVideoBuff':                  // ④ 预览帧
      document.querySelector('#preview').src = 'data:' + msg.mime + ';base64,' + msg.imgBase64Str
      break
    case 'OpenCamera':                          // ③ 设备已打开，稍后即可拍照
      setTimeout(() => ws.send(JSON.stringify({ func: 'CameraCaptureBase64', reqId: String(++reqId) })), 1000)
      break
    case 'CameraCaptureBase64':                 // ⑤ 拍照结果
      console.log('拍照成功', msg.width + 'x' + msg.height, msg.mime)
      break
  }
}
```

## 协议指令一览

| func | 方向 | 关键字段 | 说明 |
|------|------|----------|------|
| `GetCameraInfo` | 请求 → 响应 | 响应含 `devInfo[]`：`{id, devName, mediaTypes:[{mediaType, resolutions[]}]}` | 返回模拟设备列表 |
| `OpenCamera` | 请求 → 响应 | `devNum`、`mediaNum`、`resolutionNum`、`fps` | 打开指定设备 |
| `SetCameraInfo` | 请求 → 响应 | `mediaNum`、`resolutionNum` | 切换媒体格式 / 分辨率 |
| `SetCameraImageInfo` | 请求 → 响应 | `cropType`、`imageType` | 设置图像算法参数 |
| `GetCameraVideoBuff` | 请求；响应为定时推送 | 请求 `devNum`、`enable:"true"/"false"`；帧含 `mime`、`imgBase64Str`、`width`、`height` | 开启 / 停止预览流推送 |
| `CameraCaptureBase64` | 请求 → 响应 | 响应含 `mime`、`imgBase64Str`、`width`、`height` | 拍照，返回单帧 base64 |
| `CloseCamera` | 请求 → 响应 | `devNum` | 关闭设备并停止推帧 |
| `GetOcrSupportInfo` | 请求 → 响应 | 响应含 `languages[]` | 返回支持的 OCR 语言列表 |
| `ExternalButton` | 请求 → 响应 | — | 外部按钮占位指令，直接返回成功 |

约定：所有消息均为 JSON 文本帧；`reqId` 原样回传；`result` 为 `0` 表示成功（前端把非 `0` 且非 `9` 视为错误并读取 `errorMsg`）。

## 模拟设备清单

| id | 设备名 | 媒体格式 | 可选分辨率 |
|----|--------|----------|------------|
| 0 | 模拟高拍仪-1 (USB 2.0) | MJPG / YUY2 | 640x480、1280x720、1920x1080 |
| 1 | 模拟高拍仪-2 (USB 3.0) | MJPG | 640x480、2592x1944 |

## 可配置参数

编辑 `high-speed-scanner.js` 顶部常量：

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8082` | WebSocket 监听端口；修改后需同步前端 `VUE_APP_HIGH_SPEED_SCANNER_URL` |
| `VIDEO_FPS` | `5` | 预览帧率 |
| `VIDEO_WIDTH` | `640` | 预览帧宽度 |
| `VIDEO_HEIGHT` | `480` | 预览帧高度 |

## 常见问题

- **弹窗提示「未连接websocket服务器，请确保已运行服务端!」**：本服务未启动、端口不一致，或修改 `.env` 后前端未重启。
- **设备下拉提示「高拍仪设备信息为空」**：连接成功但设备列表为空；模拟服务固定返回 2 台设备，出现此提示说明连到了其他服务。
- **预览黑屏 / 不动**：确认已发送 `GetCameraVideoBuff` 且 `enable:"true"`；刷新页面重新建连。
- **端口被占用**：修改 `PORT` 并同步前端环境变量。

## 与真实高拍仪的差异

- 设备列表固定为 2 台模拟设备，不支持设备热插拔；bp-lims 组件监听的 `Notify`/`OnDeviceChanged` 推送在模拟服务上不会出现（该分支不触发，属预期行为）。
- 预览与拍照画面均为程序合成的模拟面单底照，仅分辨率与噪点强度不同，非真实拍摄内容。
- OCR / 条码识别相关指令仅返回支持项列表，不做真实识别。

## 项目结构

```text
├── high-speed-scanner.js   # WebSocket 服务、协议路由、会话管理
├── waybill-renderer.js     # 模拟面单底照渲染管线（6 层合成）
├── png-encoder.js          # PNG 编码器（纯 JS）
├── docs/preview-dialog.png # 前端接入效果预览图
└── package.json
```
