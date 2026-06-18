/**
 * 高拍仪 WebSocket 模拟服务
 *
 * 模拟本地高拍仪桌面程序提供的 WebSocket 服务，用于前端无设备时的联调开发。
 * 完全模拟真实协议：GetCameraInfo / OpenCamera / GetCameraVideoBuff / CameraCaptureBase64 等。
 *
 * 使用方式：
 *   cd hussar-front
 *   npm install ws
 *   node mock/high-speed-scanner-mock.js
 *
 * 服务监听 ws://127.0.0.1:8082
 */

const { createServer } = require('http')
const { WebSocketServer } = require('ws')
const zlib = require('zlib')

// ============================================================
// 可配置参数
// ============================================================
const PORT = 8082
const VIDEO_FPS = 5 // 预览帧率（与前端 OpenCamera 的 fps 参数一致）
const VIDEO_WIDTH = 640
const VIDEO_HEIGHT = 480

// 模拟设备列表
const MOCK_DEVICES = [
    {
        id: 0,
        devName: '模拟高拍仪-1 (USB 2.0)',
        mediaTypes: [
            { mediaType: 'MJPG', resolutions: ['640x480', '1280x720', '1920x1080'] },
            { mediaType: 'YUY2', resolutions: ['640x480', '1280x720'] }
        ]
    },
    { id: 1, devName: '模拟高拍仪-2 (USB 3.0)', mediaTypes: [{ mediaType: 'MJPG', resolutions: ['640x480', '2592x1944'] }] }
]

// ============================================================
// 工具：纯 Node.js 生成简单 PNG 图片
// ============================================================

/**
 * 生成带文字标识的模拟 PNG 图片 (纯 JS，无外部依赖)
 */
function generateMockPngBase64(width, height, label, r, g, b) {
    const rawData = createRawPixels(width, height, label, r, g, b)
    const pngBuffer = buildPng(width, height, rawData)
    return pngBuffer.toString('base64')
}

/**
 * 创建 RGBA 像素数据
 * 画一个渐变色背景 + 简单的像素文字水印
 */
function createRawPixels(width, height, label, r, g, b) {
    const raw = Buffer.alloc((width * 4 + 1) * height) // filter byte + row

    for (let y = 0; y < height; y++) {
        const rowOffset = y * (width * 4 + 1)
        raw[rowOffset] = 0 // filter: none

        for (let x = 0; x < width; x++) {
            const px = rowOffset + 1 + x * 4

            // 背景：水平渐变 + 垂直渐变
            const bgR = Math.floor(r * 0.3 + r * 0.7 * (x / width))
            const bgG = Math.floor(g * 0.3 + g * 0.7 * (y / height))
            const bgB = Math.floor(b * 0.3 + b * 0.7 * ((x + y) / (width + height)))

            raw[px] = bgR // R
            raw[px + 1] = bgG // G
            raw[px + 2] = bgB // B
            raw[px + 3] = 255 // A
        }
    }

    // 在图片中间画一个白色十字准星
    const cx = Math.floor(width / 2)
    const cy = Math.floor(height / 2)
    const crossLen = 80
    const crossThick = 3

    // 水平线
    for (let dx = -crossLen; dx <= crossLen; dx++) {
        for (let t = -Math.floor(crossThick / 2); t <= Math.floor(crossThick / 2); t++) {
            const px = cx + dx
            const py = cy + t
            if (px >= 0 && px < width && py >= 0 && py < height) {
                const offset = py * (width * 4 + 1) + 1 + px * 4
                raw[offset] = 255
                raw[offset + 1] = 255
                raw[offset + 2] = 255
                raw[offset + 3] = 255
            }
        }
    }

    // 垂直线
    for (let dy = -crossLen; dy <= crossLen; dy++) {
        for (let t = -Math.floor(crossThick / 2); t <= Math.floor(crossThick / 2); t++) {
            const px = cx + t
            const py = cy + dy
            if (px >= 0 && px < width && py >= 0 && py < height) {
                const offset = py * (width * 4 + 1) + 1 + px * 4
                raw[offset] = 255
                raw[offset + 1] = 255
                raw[offset + 2] = 255
                raw[offset + 3] = 255
            }
        }
    }

    // 底部文字区域：画一个半透明黑条
    const textBarY = Math.floor(height * 0.85)
    const textBarH = 50
    for (let y = textBarY; y < textBarY + textBarH && y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = y * (width * 4 + 1) + 1 + x * 4
            raw[offset] = Math.floor(raw[offset] * 0.5)
            raw[offset + 1] = Math.floor(raw[offset + 1] * 0.5)
            raw[offset + 2] = Math.floor(raw[offset + 2] * 0.5)
        }
    }

    // 简单像素文字（8x16 位图字体）—— 只支持大写字母和数字
    const textX = Math.floor((width - label.length * 10) / 2)
    const textY = textBarY + 12
    drawPixelText(raw, width, label, textX, textY, 255, 255, 255)

    // 右下角时间戳
    const ts = new Date().toLocaleString('zh-CN')
    drawPixelText(raw, width, ts, 10, height - 20, 255, 255, 255)

    return raw
}

// 简易 5x8 像素字体（大写 A-Z, 0-9, 符号）
const FONT_5X8 = {
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001', '00000'],
    B: ['11110', '10001', '11110', '10001', '10001', '11110', '00000', '00000'],
    C: ['01110', '10001', '10000', '10000', '10001', '01110', '00000', '00000'],
    D: ['11110', '10001', '10001', '10001', '10001', '11110', '00000', '00000'],
    E: ['11111', '10000', '11110', '10000', '10000', '11111', '00000', '00000'],
    F: ['11111', '10000', '11110', '10000', '10000', '10000', '00000', '00000'],
    G: ['01110', '10001', '10000', '10111', '10001', '01110', '00000', '00000'],
    H: ['10001', '10001', '11111', '10001', '10001', '10001', '00000', '00000'],
    I: ['01110', '00100', '00100', '00100', '00100', '01110', '00000', '00000'],
    J: ['00111', '00010', '00010', '00010', '10010', '01100', '00000', '00000'],
    K: ['10001', '10010', '11100', '10010', '10001', '10001', '00000', '00000'],
    L: ['10000', '10000', '10000', '10000', '10000', '11111', '00000', '00000'],
    M: ['10001', '11011', '10101', '10001', '10001', '10001', '00000', '00000'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '00000', '00000'],
    O: ['01110', '10001', '10001', '10001', '10001', '01110', '00000', '00000'],
    P: ['11110', '10001', '11110', '10000', '10000', '10000', '00000', '00000'],
    Q: ['01110', '10001', '10001', '10101', '10010', '01101', '00000', '00000'],
    R: ['11110', '10001', '11110', '10010', '10001', '10001', '00000', '00000'],
    S: ['01110', '10001', '10000', '01110', '00001', '11110', '00000', '00000'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00000', '00000'],
    U: ['10001', '10001', '10001', '10001', '10001', '01110', '00000', '00000'],
    V: ['10001', '10001', '10001', '01010', '01010', '00100', '00000', '00000'],
    W: ['10001', '10001', '10101', '11011', '10001', '10001', '00000', '00000'],
    X: ['10001', '01010', '00100', '00100', '01010', '10001', '00000', '00000'],
    Y: ['10001', '01010', '00100', '00100', '00100', '00100', '00000', '00000'],
    Z: ['11111', '00010', '00100', '01000', '10000', '11111', '00000', '00000'],
    0: ['01110', '10011', '10101', '11001', '10001', '01110', '00000', '00000'],
    1: ['00100', '01100', '00100', '00100', '00100', '01110', '00000', '00000'],
    2: ['01110', '10001', '00010', '00100', '01000', '11111', '00000', '00000'],
    3: ['01110', '10001', '00001', '00110', '10001', '01110', '00000', '00000'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00000', '00000'],
    5: ['11111', '10000', '11110', '00001', '00001', '11110', '00000', '00000'],
    6: ['01110', '10000', '11110', '10001', '10001', '01110', '00000', '00000'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '00000', '00000'],
    8: ['01110', '10001', '01110', '10001', '10001', '01110', '00000', '00000'],
    9: ['01110', '10001', '01111', '00001', '00010', '01100', '00000', '00000'],
    '-': ['00000', '00000', '11111', '00000', '00000', '00000', '00000', '00000'],
    ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000', '00000'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000', '00000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100', '00000'],
    '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000', '00000']
}

function drawPixelText(raw, imgWidth, text, startX, startY, r, g, b) {
    let cx = startX
    for (let i = 0; i < text.length; i++) {
        const ch = text[i].toUpperCase()
        const glyph = FONT_5X8[ch]
        if (!glyph) {
            cx += 6
            continue
        }
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 5; col++) {
                if (glyph[row] && glyph[row][col] === '1') {
                    const px = cx + col + 1
                    const py = startY + row
                    if (px >= 0 && px < imgWidth && py >= 0) {
                        const offset = py * (imgWidth * 4 + 1) + 1 + px * 4
                        raw[offset] = r
                        raw[offset + 1] = g
                        raw[offset + 2] = b
                        raw[offset + 3] = 255
                    }
                }
            }
        }
        cx += 10 // 字符间距
    }
}

// Fix: dy_impl undefined — inline the logic properly
// The crosshair drawing code above had a bug. Let me fix it in the final version.

/**
 * 构建 PNG 文件缓冲区
 */
function buildPng(width, height, rawData) {
    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

    // IHDR
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 6 // color type: RGBA
    ihdr[10] = 0 // compression
    ihdr[11] = 0 // filter
    ihdr[12] = 0 // interlace
    const ihdrChunk = createChunk('IHDR', ihdr)

    // IDAT — compress raw pixel data
    const compressed = zlib.deflateSync(rawData)
    const idatChunk = createChunk('IDAT', compressed)

    // IEND
    const iendChunk = createChunk('IEND', Buffer.alloc(0))

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk])
}

function createChunk(type, data) {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const typeB = Buffer.from(type, 'ascii')
    const crc = crc32(Buffer.concat([typeB, data]))
    const crcB = Buffer.alloc(4)
    crcB.writeUInt32BE(crc, 0)
    return Buffer.concat([len, typeB, data, crcB])
}

function crc32(buf) {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

// CRC32 查找表
const CRC_TABLE = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        }
        t[n] = c
    }
    return t
})()

// ============================================================
// 模拟高拍仪服务
// ============================================================

// 帧计数器（用于生成变化的预览帧）
let frameSeq = 0

function createMockServer() {
    const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' })

    console.log('╔══════════════════════════════════════════════╗')
    console.log('║     🎥 高拍仪 WebSocket 模拟服务已启动       ║')
    console.log(`║     监听地址: ws://127.0.0.1:${PORT}              ║`)
    console.log('║     模拟设备: 2 台                             ║')
    console.log('║     按 Ctrl+C 停止服务                         ║')
    console.log('╚══════════════════════════════════════════════╝')

    wss.on('connection', ws => {
        const session = {
            openDevNum: -1,
            videoTimer: null,
            videoEnabled: false
        }

        console.log('[连接] 前端已连接')

        ws.on('message', data => {
            let msg
            try {
                msg = JSON.parse(data.toString())
            } catch (e) {
                console.log('[错误] 无法解析消息:', data.toString())
                return
            }

            console.log('[收到]', msg.func, msg)

            switch (msg.func) {
                // --------------------------------------------------
                case 'GetCameraInfo':
                    sendJson(ws, {
                        func: 'GetCameraInfo',
                        reqId: msg.reqId,
                        result: 0,
                        devInfo: MOCK_DEVICES
                    })
                    break

                // --------------------------------------------------
                case 'OpenCamera':
                    // 先关闭之前的摄像头
                    if (session.videoTimer) {
                        clearInterval(session.videoTimer)
                    }
                    session.openDevNum = msg.devNum
                    session.mediaNum = msg.mediaNum || 0
                    session.resolutionNum = msg.resolutionNum || 0
                    session.fps = msg.fps || 5
                    console.log(`[摄像头] 打开设备 ${msg.devNum}, media=${session.mediaNum}, resolution=${session.resolutionNum}`)
                    sendJson(ws, {
                        func: 'OpenCamera',
                        reqId: msg.reqId,
                        result: 0
                    })
                    break

                // --------------------------------------------------
                case 'GetCameraVideoBuff':
                    if (msg.enable === 'true' || msg.enable === true) {
                        session.videoEnabled = true
                        // 清除旧定时器
                        if (session.videoTimer) clearInterval(session.videoTimer)
                        // 定时推送模拟视频帧
                        const interval = Math.floor(1000 / session.fps)
                        session.videoTimer = setInterval(() => {
                            if (ws.readyState !== ws.OPEN) {
                                clearInterval(session.videoTimer)
                                return
                            }
                            frameSeq++
                            const pngBase64 = generateFramePng(VIDEO_WIDTH, VIDEO_HEIGHT, frameSeq)

                            sendJson(ws, {
                                func: 'GetCameraVideoBuff',
                                reqId: msg.reqId,
                                result: 0,
                                devNum: session.openDevNum,
                                mime: 'image/png',
                                imgBase64Str: pngBase64,
                                width: VIDEO_WIDTH,
                                height: VIDEO_HEIGHT
                            })
                        }, interval)
                        console.log(`[预览] 开始推送视频帧 (${session.fps} fps)`)
                    } else {
                        session.videoEnabled = false
                        if (session.videoTimer) {
                            clearInterval(session.videoTimer)
                            session.videoTimer = null
                        }
                        console.log('[预览] 停止推送视频帧')
                    }
                    break

                // --------------------------------------------------
                case 'SetCameraInfo':
                    console.log(`[设置] 视频参数: media=${msg.mediaNum}, resolution=${msg.resolutionNum}`)
                    session.mediaNum = msg.mediaNum
                    session.resolutionNum = msg.resolutionNum
                    sendJson(ws, {
                        func: 'SetCameraInfo',
                        reqId: msg.reqId,
                        result: 0
                    })
                    break

                // --------------------------------------------------
                case 'SetCameraImageInfo':
                    console.log(`[设置] 图像算法: cropType=${msg.cropType}, imageType=${msg.imageType}`)
                    sendJson(ws, {
                        func: 'SetCameraImageInfo',
                        reqId: msg.reqId,
                        result: 0
                    })
                    break

                // --------------------------------------------------
                case 'CameraCaptureBase64':
                    console.log('[拍照] 执行拍照')
                    // 生成一张"拍照"图片（与预览帧不同的配色，模拟拍照效果）
                    const capturedPng = generateCapturePng(VIDEO_WIDTH, VIDEO_HEIGHT, session.openDevNum)
                    sendJson(ws, {
                        func: 'CameraCaptureBase64',
                        reqId: msg.reqId,
                        result: 0,
                        devNum: session.openDevNum,
                        mime: 'image/png',
                        imgBase64Str: capturedPng,
                        width: VIDEO_WIDTH,
                        height: VIDEO_HEIGHT
                    })
                    break

                // --------------------------------------------------
                case 'CloseCamera':
                    console.log(`[摄像头] 关闭设备 ${msg.devNum}`)
                    if (session.videoTimer) {
                        clearInterval(session.videoTimer)
                        session.videoTimer = null
                    }
                    session.videoEnabled = false
                    session.openDevNum = -1
                    sendJson(ws, {
                        func: 'CloseCamera',
                        reqId: msg.reqId,
                        result: 0
                    })
                    break

                // --------------------------------------------------
                case 'GetOcrSupportInfo':
                    sendJson(ws, {
                        func: 'GetOcrSupportInfo',
                        reqId: msg.reqId,
                        result: 0,
                        languages: ['Simplified Chinese', 'English', 'Simplified Chinese+English']
                    })
                    break

                // --------------------------------------------------
                // 外部按钮（未使用，兼容不报错）
                case 'ExternalButton':
                    sendJson(ws, {
                        func: 'ExternalButton',
                        reqId: msg.reqId,
                        result: 0
                    })
                    break

                default:
                    console.log('[未知指令]', msg.func)
                    sendJson(ws, {
                        func: msg.func,
                        reqId: msg.reqId,
                        result: 0
                    })
            }
        })

        ws.on('close', () => {
            console.log('[连接] 前端已断开')
            if (session.videoTimer) {
                clearInterval(session.videoTimer)
            }
        })

        ws.on('error', err => {
            console.log('[错误]', err.message)
        })
    })
}

/**
 * 生成预览帧（动态变化，模拟实时视频流）
 */
function generateFramePng(width, height, seq) {
    // 颜色随时间变化，模拟真实摄像头
    const hue = (seq * 13) % 360
    const rgb = hslToRgb(hue / 360, 0.6, 0.5)
    return generateMockPngBase64(width, height, `FRAME:${seq}`, rgb[0], rgb[1], rgb[2])
}

/**
 * 生成拍照图片（不同于预览帧，模拟"快门按下瞬间"）
 */
function generateCapturePng(width, height, devNum) {
    // 拍照用固定绿色调，与预览帧区分
    return generateMockPngBase64(width, height, `CAPTURE-DEV${devNum}`, 40, 120, 80)
}

function hslToRgb(h, s, l) {
    let r, g, b
    if (s === 0) {
        r = g = b = l
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1
            if (t > 1) t -= 1
            if (t < 1 / 6) return p + (q - p) * 6 * t
            if (t < 1 / 2) return q
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
            return p
        }
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s
        const p = 2 * l - q
        r = hue2rgb(p, q, h + 1 / 3)
        g = hue2rgb(p, q, h)
        b = hue2rgb(p, q, h - 1 / 3)
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

function sendJson(ws, obj) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(obj))
    }
}

// ============================================================
// 启动
// ============================================================
createMockServer()
