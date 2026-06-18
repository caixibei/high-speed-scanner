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
const { renderPreviewFrame, renderCaptureFrame } = require('./waybill-renderer')

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
 * 生成预览帧（委托面单渲染器，模拟高拍仪实时视频流）
 */
function generateFramePng(width, height, seq) {
    return renderPreviewFrame(width, height, seq)
}

/**
 * 生成拍照图片（委托面单渲染器，更高分辨率 + 低噪点，模拟快门瞬间）
 */
function generateCapturePng(width, height, devNum) {
    const capW = width >= 1280 ? width : 1280
    const capH = height >= 720 ? height : 960
    return renderCaptureFrame(capW, capH, devNum)
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
