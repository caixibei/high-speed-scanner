/**
 * PNG 编码器 — 纯 Node.js 实现，无外部依赖
 *
 * 将 RGBA 像素缓冲区编码为 PNG 文件格式（Base64 字符串）。
 * 像素缓冲格式：每行 1 字节 filter(0) + width*4 字节 RGBA。
 * 该模块从 high-speed-scanner.js 抽离，供面单渲染器复用。
 */

const zlib = require('zlib')

// CRC32 查找表（单例，模块加载时初始化，后续所有 PNG 编码共用）
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

function crc32(buf) {
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
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

/**
 * 构建 PNG 文件缓冲区
 * @param {number} width - 图像宽度
 * @param {number} height - 图像高度
 * @param {Buffer} rawData - 原始像素数据（含 filter byte）
 * @returns {Buffer} 完整 PNG 文件
 */
function buildPng(width, height, rawData) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(width, 0)
    ihdr.writeUInt32BE(height, 4)
    ihdr[8] = 8  // bit depth: 8 bits per channel
    ihdr[9] = 6  // color type: RGBA
    ihdr[10] = 0 // compression: deflate
    ihdr[11] = 0 // filter: adaptive (实际每行用 filter byte 0=None)
    ihdr[12] = 0 // interlace: none
    const ihdrChunk = createChunk('IHDR', ihdr)

    const compressed = zlib.deflateSync(rawData)
    const idatChunk = createChunk('IDAT', compressed)

    const iendChunk = createChunk('IEND', Buffer.alloc(0))

    return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk])
}

/**
 * 将 RGBA 像素缓冲区编码为 Base64 PNG 字符串
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rawData - 原始像素数据（含 filter byte）
 * @returns {string} Base64 编码的 PNG
 */
function generatePngBase64(width, height, rawData) {
    return buildPng(width, height, rawData).toString('base64')
}

module.exports = { buildPng, generatePngBase64 }
