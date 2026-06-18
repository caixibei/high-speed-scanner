/**
 * 快递面单底照渲染器
 *
 * 模拟高拍仪拍摄快递面单的视觉效果。渲染管线：
 *   扫描台背景（深灰底板 + 侧光渐变）
 *   → 纸张矩形（奶白色 + 轻微旋转 + 投影）
 *   → 面单模板内容（寄件人/收件人/条形码/印章/二维码/分隔线）
 *   → 纸张纹理（低频亮度波动，模拟纸纤维）
 *   → 传感器噪点（Box-Muller 高斯近似，模拟 CMOS 热噪点）
 *   → 暗角效果（四角渐变压暗，模拟镜头 vignetting）
 *
 * 预览帧：有抖动、中等噪点；拍照帧：固定姿态、低噪点、更高分辨率。
 */

const { generatePngBase64 } = require('./png-encoder')

// ============================================================
// 基础缓冲区操作
// ============================================================

/**
 * 创建 RGBA 像素缓冲区
 * 格式：每行 1 字节 filter(0) + width*4 字节 RGBA
 */
function createRawBuffer(width, height) {
    const buf = Buffer.alloc((width * 4 + 1) * height)
    for (let y = 0; y < height; y++) {
        buf[y * (width * 4 + 1)] = 0 // filter: none
    }
    return buf
}

/**
 * 在指定坐标写入 RGBA 像素值（自动跳过每行的 filter byte）
 * 坐标越界静默忽略，避免边缘绘制时的边界判断开销
 */
function setPixel(raw, width, x, y, r, g, b, a) {
    if (x < 0 || x >= width || y < 0) return
    const rowStart = y * (width * 4 + 1)
    if (rowStart >= raw.length) return
    const offset = rowStart + 1 + x * 4
    raw[offset] = clamp(r, 0, 255)
    raw[offset + 1] = clamp(g, 0, 255)
    raw[offset + 2] = clamp(b, 0, 255)
    raw[offset + 3] = clamp(a, 0, 255)
}

function clamp(v, min, max) {
    return v < min ? min : v > max ? max : Math.round(v)
}

// ============================================================
// 简单伪随机数生成器（保证不同帧/模板间可复现）
// ============================================================
function seededRandom(seed) {
    let s = seed | 0
    return function () {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        return s / 0x7fffffff
    }
}

// ============================================================
// 第 1 层：扫描台背景（模拟设备内部深色底板 + LED 侧光）
// ============================================================
function fillScannerBed(raw, width, height) {
    for (let y = 0; y < height; y++) {
        const rowStart = y * (width * 4 + 1)
        for (let x = 0; x < width; x++) {
            const offset = rowStart + 1 + x * 4
            // 深灰底色 + 水平轻微渐变（左侧 LED 光源，从左到右渐暗）
            const v = 28 + Math.floor(12 * (1 - x / width))
            raw[offset] = v
            raw[offset + 1] = v
            raw[offset + 2] = v
            raw[offset + 3] = 255
        }
    }
}

// ============================================================
// 第 2 层：纸张矩形（含旋转与投影）
// ============================================================

/**
 * 绘制纸张矩形并返回纸张区域元数据
 *
 * 使用扫描线算法：对每一行，计算该行与旋转后纸张四边形的交点区间，
 * 区间内填充纸色，区间外保持扫描台背景。
 * 纸张右下方向添加投影：在纸张外侧右下区域像素做局部变暗。
 *
 * @returns {{ cx, cy, paperW, paperH, angle, corners }} 纸张区域元数据
 */
function drawPaper(raw, width, height, frameSeq) {
    // 纸张尺寸占画面约 78%×88%，模拟 A4 纸比例
    const paperW = Math.floor(width * 0.78)
    const paperH = Math.floor(height * 0.88)
    const cx = Math.floor(width / 2)
    const cy = Math.floor(height / 2)

    // 旋转角：基于帧序号循环 ±2°，预览帧叠加 ±0.3° 抖动
    const baseAngle = ((frameSeq * 7) % 5 - 2) * (Math.PI / 180)
    const jitter = (frameSeq % 3 - 1) * 0.3 * (Math.PI / 180)
    const angle = baseAngle + jitter

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)

    const hw = paperW / 2
    const hh = paperH / 2
    const corners = [
        { x: -hw, y: -hh },
        { x:  hw, y: -hh },
        { x:  hw, y:  hh },
        { x: -hw, y:  hh }
    ].map(p => ({
        x: cx + p.x * cos - p.y * sin,
        y: cy + p.x * sin + p.y * cos
    }))

    // 投影参数：右下偏移 5px
    const shadowOffX = 5
    const shadowOffY = 5

    // 预计算投影多边形角点，用于判断像素是否在投影区域内
    const shadowCorners = corners.map(c => ({
        x: c.x + shadowOffX,
        y: c.y + shadowOffY
    }))

    // 扫描线填充纸张 + 投影
    for (let y = 0; y < height; y++) {
        const paperHit = linePolygonIntersections(y, corners)
        const shadowHit = linePolygonIntersections(y, shadowCorners)

        if (paperHit.length >= 2) {
            const xMin = Math.max(0, Math.floor(paperHit[0]))
            const xMax = Math.min(width - 1, Math.ceil(paperHit[paperHit.length - 1]))

            for (let x = xMin; x <= xMax; x++) {
                const rowStart = y * (width * 4 + 1)
                const offset = rowStart + 1 + x * 4
                // 奶白色纸底，微暖色调（R=G=248, B=240 偏暖）
                raw[offset] = 248
                raw[offset + 1] = 248
                raw[offset + 2] = 240
                raw[offset + 3] = 255
            }
        }

        // 投影区域：在纸张外侧右下、但在投影多边形内的像素做暗化
        if (shadowHit.length >= 2) {
            const sxMin = Math.max(0, Math.floor(shadowHit[0]))
            const sxMax = Math.min(width - 1, Math.ceil(shadowHit[shadowHit.length - 1]))
            for (let x = sxMin; x <= sxMax; x++) {
                // 仅处理纸张外侧（即不在纸内的投影区域）
                const inPaper = paperHit.length >= 2 &&
                    x >= Math.floor(paperHit[0]) &&
                    x <= Math.ceil(paperHit[paperHit.length - 1])
                if (inPaper) continue

                const rowStart = y * (width * 4 + 1)
                const offset = rowStart + 1 + x * 4
                // 投影暗化系数 0.5，使底部像素接近扫描台色
                raw[offset] = clamp(raw[offset] * 0.5, 0, 255)
                raw[offset + 1] = clamp(raw[offset + 1] * 0.5, 0, 255)
                raw[offset + 2] = clamp(raw[offset + 2] * 0.5, 0, 255)
            }
        }
    }

    return { cx, cy, paperW, paperH, angle, corners }
}

/**
 * 计算水平扫描线与多边形的交点 x 坐标（排序后返回）
 * 用于扫描线填充算法——对每行像素快速判定多边形内部区间
 */
function linePolygonIntersections(y, corners) {
    const intersections = []
    for (let i = 0; i < corners.length; i++) {
        const p1 = corners[i]
        const p2 = corners[(i + 1) % corners.length]
        if ((p1.y <= y && p2.y > y) || (p2.y <= y && p1.y > y)) {
            const t = (y - p1.y) / (p2.y - p1.y)
            intersections.push(p1.x + t * (p2.x - p1.x))
        }
    }
    return intersections.sort((a, b) => a - b)
}

// ============================================================
// 面单模板系统（6 套，模拟不同快递公司面单布局）
// ============================================================

const COMPANIES = ['顺丰速运', '中通快递', '圆通速递', '韵达快递', '申通快递', '极兔速递']

/**
 * 根据帧序号选择面单模板
 * 每 4 帧轮换一套模板，不同模板的面单区域位置各有微小偏移，
 * 避免千篇一律的视觉效果。
 *
 * @returns {{ company: string, senderY: number, 各区域在纸张内的相对坐标 }}
 */
function selectTemplate(seq) {
    const idx = Math.floor(seq / 4) % COMPANIES.length
    const rng = seededRandom(idx * 1000 + 42)

    return {
        company: COMPANIES[idx],
        senderY: 0.06 + rng() * 0.04,
        senderH: 0.15,
        logoY: 0.04 + rng() * 0.03,
        logoH: 0.10,
        barcodeY: 0.24 + rng() * 0.05,
        barcodeH: 0.12,
        recipientY: 0.42 + rng() * 0.05,
        recipientH: 0.16,
        tableY: 0.65 + rng() * 0.05,
        tableH: 0.20,
        qrY: 0.75 + rng() * 0.05,
        qrX: 0.72 + rng() * 0.1,
        qrSize: 56 + Math.floor(rng() * 16)
    }
}

// ============================================================
// 文本块绘制（模拟段落文字，用灰色横线代替渲染字符）
// ============================================================

/**
 * 在纸张相对坐标内绘制模拟文字块
 *
 * 用深灰色横线模拟多行印刷文字，每行长度和粗细随机变化，
 * 模仿不同字数和字体粗细的段落效果。末尾一行通常更短，
 * 模拟段落末行特征。字符间距通过每 7px 留白模拟。
 *
 * @param {number} rx, ry, rw, rh - 纸张内的相对坐标与尺寸 (0-1)
 * @param {number} lines - 文字行数
 */
function drawTextBlock(raw, width, height, paperMeta, rx, ry, rw, rh, lines, rng) {
    const absX = paperMeta.cx - paperMeta.paperW / 2 + rx * paperMeta.paperW
    const absY = paperMeta.cy - paperMeta.paperH / 2 + ry * paperMeta.paperH
    const absW = rw * paperMeta.paperW
    const absH = rh * paperMeta.paperH

    const lineHeight = Math.max(4, Math.floor(absH / Math.max(lines, 1)))
    const gray = 60 + Math.floor(rng() * 30)

    for (let i = 0; i < lines; i++) {
        const ly = Math.floor(absY + i * lineHeight + lineHeight * 0.6)
        // 末行短尾（30%-70%），其他行 65%-95%
        const lineLen = i === lines - 1
            ? absW * (0.3 + rng() * 0.4)
            : absW * (0.65 + rng() * 0.3)

        const lx = Math.floor(absX)
        const lw = Math.floor(lineLen)
        const thickness = 1 + Math.floor(rng() * 1.5)

        for (let t = 0; t < thickness; t++) {
            for (let dx = 0; dx < lw; dx++) {
                // 每 7px 留白 2px，模拟字间距
                const g = (dx % 7 > 1) ? gray : 248
                setPixel(raw, width, lx + dx, ly + t, g, g, g, 255)
            }
        }
    }
}

// ============================================================
// 条形码绘制（模拟 Code128 条码 + 运单号）
// ============================================================

/**
 * 绘制模拟条形码
 *
 * 生成纵向黑白相间竖线模拟 Code128 条码外观，
 * 条宽 1-4px 随机、间隔 1-3px 随机。下方附运单号数字。
 * 运单号格式：快递公司两位字母前缀 + 12 位数字。
 */
function drawBarcode(raw, width, height, paperMeta, rx, ry, rw, rh, rng) {
    const absX = paperMeta.cx - paperMeta.paperW / 2 + rx * paperMeta.paperW
    const absY = paperMeta.cy - paperMeta.paperH / 2 + ry * paperMeta.paperH
    const absW = rw * paperMeta.paperW
    const absH = rh * paperMeta.paperH

    let x = absX
    while (x < absX + absW) {
        const barW = 1 + Math.floor(rng() * 4)
        const gapW = 1 + Math.floor(rng() * 3)

        for (let dx = 0; dx < barW && x + dx < absX + absW; dx++) {
            for (let dy = 0; dy < absH; dy++) {
                setPixel(raw, width, Math.floor(x + dx), Math.floor(absY + dy), 0, 0, 0, 255)
            }
        }
        x += barW + gapW
    }

    // 下方运单号
    const trackingNum = generateTrackingNumber(rng)
    const numY = Math.floor(absY + absH + 6)
    const numLen = trackingNum.length * 7
    const numX = Math.floor(absX + (absW - numLen) / 2)
    drawNumberString(raw, width, numX, numY, trackingNum, rng)
}

function generateTrackingNumber(rng) {
    const prefix = ['SF', 'ZT', 'YT', 'YD', 'ST', 'JT'][Math.floor(rng() * 6)]
    let num = prefix
    for (let i = 0; i < 12; i++) {
        num += Math.floor(rng() * 10).toString()
    }
    return num
}

/**
 * 用 5×7 字符网格绘制数字/字母串
 * 每个字符通过散列值决定点亮像素，模拟点阵字形
 */
function drawNumberString(raw, width, startX, startY, str, rng) {
    for (let i = 0; i < str.length; i++) {
        const cx = startX + i * 7
        const ch = str[i]
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                if (shouldLightCharPixel(ch, row, col)) {
                    setPixel(raw, width, cx + col, startY + row, 10, 10, 10, 255)
                }
            }
        }
    }
}

function shouldLightCharPixel(ch, row, col) {
    const code = ch.charCodeAt(0)
    const seed = code * 31 + row * 7 + col * 13
    return (seed % 7) < 3 || (code === 48 && col < 3 && row < 5 && row > 1)
}

// ============================================================
// 印章绘制（模拟圆形红色公章）
// ============================================================

/**
 * 绘制模拟圆形红色印章
 *
 * 在快递面单右上角绘制红色圆章：外层红圈（2px 宽）+ 中心红色圆点（简化五角星），
 * 透明度 200/255 模拟半透印章油墨效果。
 */
function drawStamp(raw, width, height, paperMeta, rx, ry, size, company, rng) {
    const cx = Math.floor(paperMeta.cx - paperMeta.paperW / 2 + rx * paperMeta.paperW)
    const cy = Math.floor(paperMeta.cy - paperMeta.paperH / 2 + ry * paperMeta.paperH)
    const r = size / 2

    // 外层红圈（步进 2° 保证圆环连续）
    for (let a = 0; a < 360; a += 2) {
        const rad = a * Math.PI / 180
        for (let t = r - 2; t <= r; t++) {
            const px = Math.floor(cx + t * Math.cos(rad))
            const py = Math.floor(cy + t * Math.sin(rad))
            // 印章红色 + 半透明（Alpha=200），叠在纸色上产生自然融合
            setPixel(raw, width, px, py, 180, 30, 30, 200)
        }
    }

    // 中心红色圆点（简化五角星，保持视觉辨识度）
    for (let dy = -r / 3; dy <= r / 3; dy++) {
        for (let dx = -r / 3; dx <= r / 3; dx++) {
            if (dx * dx + dy * dy < (r / 4) * (r / 4)) {
                setPixel(raw, width, Math.floor(cx + dx), Math.floor(cy + dy), 180, 30, 30, 200)
            }
        }
    }
}

// ============================================================
// 二维码绘制（Version 1, 21×21 模块 + 三组定位图案）
// ============================================================

/**
 * 绘制模拟二维码
 *
 * 生成 21×21 模块的 QR 码图案：三个角各有 7×7 定位图案（黑框+白间隔+黑心），
 * 其余数据模块随机填充（黑白比约 45:55）。模块最小 2px 保证可视性。
 */
function drawQRCode(raw, width, height, paperMeta, rx, ry, size, rng) {
    const absX = Math.floor(paperMeta.cx - paperMeta.paperW / 2 + rx * paperMeta.paperW)
    const absY = Math.floor(paperMeta.cy - paperMeta.paperH / 2 + ry * paperMeta.paperH)
    const modules = 21
    const moduleSize = Math.max(2, Math.floor(size / modules))

    for (let row = 0; row < modules; row++) {
        for (let col = 0; col < modules; col++) {
            // 三个定位图案区域（左上、右上、左下 7×7）
            const isFinder = (row < 7 && col < 7) ||
                (row < 7 && col > modules - 8) ||
                (row > modules - 8 && col < 7)
            let black

            if (isFinder) {
                const localR = row < 7 ? row : (row > modules - 8 ? row - (modules - 7) : row)
                const localC = col < 7 ? col : (col > modules - 8 ? col - (modules - 7) : col)
                const onBorder = localR === 0 || localR === 6 || localC === 0 || localC === 6
                const onInner = localR >= 2 && localR <= 4 && localC >= 2 && localC <= 4
                black = onBorder || onInner
            } else {
                black = rng() > 0.55
            }

            if (black) {
                const px = absX + col * moduleSize
                const py = absY + row * moduleSize
                for (let dy = 0; dy < moduleSize; dy++) {
                    for (let dx = 0; dx < moduleSize; dx++) {
                        setPixel(raw, width, px + dx, py + dy, 0, 0, 0, 255)
                    }
                }
            }
        }
    }
}

/**
 * 绘制水平分隔线（用于面单底部的表格/备注区）
 */
function drawHLine(raw, width, height, paperMeta, rx, ry, rw, rng) {
    const absX = paperMeta.cx - paperMeta.paperW / 2 + rx * paperMeta.paperW
    const absY = Math.floor(paperMeta.cy - paperMeta.paperH / 2 + ry * paperMeta.paperH)
    const absW = rw * paperMeta.paperW

    for (let dx = 0; dx < absW; dx++) {
        setPixel(raw, width, Math.floor(absX + dx), absY, 180, 180, 180, 255)
    }
}

// ============================================================
// 面单内容组装（将上述元素按模板布局绘制到纸张上）
// ============================================================
function drawTemplateContent(raw, width, height, paperMeta, frameSeq) {
    const tmpl = selectTemplate(frameSeq)
    const rng = seededRandom(frameSeq * 777 + tmpl.company.length * 131)

    // 左上：寄件人信息（4 行文字块）
    drawTextBlock(raw, width, height, paperMeta,
        0.04, tmpl.senderY, 0.42, tmpl.senderH, 4, rng)

    // 右上：公司印章 + 公司名称
    drawStamp(raw, width, height, paperMeta, 0.80, tmpl.logoY, 40, tmpl.company, rng)
    const logoTextY = tmpl.logoY + 0.06
    drawTextBlock(raw, width, height, paperMeta,
        0.55, logoTextY, 0.30, 0.04, 1, rng)

    // 中上部：条形码区
    drawBarcode(raw, width, height, paperMeta,
        0.06, tmpl.barcodeY, 0.55, tmpl.barcodeH, rng)

    // 中下部：收件人信息（5 行，模拟更醒目的收件人文字）
    drawTextBlock(raw, width, height, paperMeta,
        0.04, tmpl.recipientY, 0.50, tmpl.recipientH, 5, rng)

    // 底部：两条水平分隔线 + 备注区字段标签
    drawHLine(raw, width, height, paperMeta, 0.04, tmpl.tableY, 0.90, rng)
    drawHLine(raw, width, height, paperMeta, 0.04, tmpl.tableY + 0.05, 0.90, rng)
    drawTextBlock(raw, width, height, paperMeta,
        0.04, tmpl.tableY + 0.02, 0.45, tmpl.tableH * 0.5, 4, rng)

    // 右下角：二维码
    drawQRCode(raw, width, height, paperMeta,
        tmpl.qrX, tmpl.qrY, tmpl.qrSize, rng)
}

// ============================================================
// 第 4 层：纸张纹理（纸纤维低频亮度波动）
// ============================================================

/**
 * 在纸张区域内叠加纸纤维纹理
 *
 * 使用分块（16px）网格噪声 + 双线性插值，产生自然的低频亮度波动，
 * 模拟真实纸张的纤维纹理。仅处理纸白色区域（R>200 判定为纸张）。
 * 纹理使用固定 seed(42)，不随帧变化，保证纸张一致性。
 */
function addPaperTexture(raw, width, height, paperMeta) {
    const blockSize = 16
    const cols = Math.ceil(width / blockSize) + 1
    const rows = Math.ceil(height / blockSize) + 1

    const grid = new Float32Array(cols * rows)
    const rng = seededRandom(42)
    for (let i = 0; i < grid.length; i++) {
        grid[i] = (rng() - 0.5) * 8 // ±4 亮度波动范围
    }

    for (let y = 0; y < height; y++) {
        const rowStart = y * (width * 4 + 1)
        const gy = y / blockSize
        const gy0 = Math.floor(gy)
        const gy1 = gy0 + 1
        const fy = gy - gy0

        for (let x = 0; x < width; x++) {
            const offset = rowStart + 1 + x * 4
            if (raw[offset] < 200) continue // 非纸张区域跳过，不影响扫描台背景

            const gx = x / blockSize
            const gx0 = Math.floor(gx)
            const gx1 = gx0 + 1
            const fx = gx - gx0

            // 双线性插值获取平滑纹理值
            const v00 = grid[gy0 * cols + gx0] || 0
            const v10 = grid[gy0 * cols + gx1] || 0
            const v01 = grid[gy1 * cols + gx0] || 0
            const v11 = grid[gy1 * cols + gx1] || 0
            const noise = v00 * (1 - fx) * (1 - fy) +
                v10 * fx * (1 - fy) +
                v01 * (1 - fx) * fy +
                v11 * fx * fy

            // R/G 通道全量叠加，B 通道 70%（暖色纹理）
            raw[offset] = clamp(raw[offset] + noise, 0, 255)
            raw[offset + 1] = clamp(raw[offset + 1] + noise, 0, 255)
            raw[offset + 2] = clamp(raw[offset + 2] + noise * 0.7, 0, 255)
        }
    }
}

// ============================================================
// 第 5 层：传感器噪点（Box-Muller 高斯近似）
// ============================================================

/**
 * 叠加 CMOS 传感器热噪点
 *
 * 使用 Box-Muller 变换将 Math.random() 均匀分布转为高斯分布，
 * 对每个像素的 R/G/B 三个通道独立添加随机偏移。
 * level 控制噪点标准差（预览帧 7、拍照帧 3）。
 */
function addSensorNoise(raw, width, height, level) {
    if (level <= 0) return

    let spare = 0
    let hasSpare = false

    for (let y = 0; y < height; y++) {
        const rowStart = y * (width * 4 + 1)
        for (let x = 0; x < width; x++) {
            const offset = rowStart + 1 + x * 4

            for (let ch = 0; ch < 3; ch++) {
                let gauss
                if (hasSpare) {
                    gauss = spare * level
                    hasSpare = false
                } else {
                    const u1 = Math.random()
                    const u2 = Math.random()
                    const mag = Math.sqrt(-2 * Math.log(u1 || 0.0001))
                    spare = mag * Math.cos(2 * Math.PI * u2)
                    const z2 = mag * Math.sin(2 * Math.PI * u2)
                    gauss = spare * level
                    spare = z2
                    hasSpare = true
                }
                raw[offset + ch] = clamp(raw[offset + ch] + gauss, 0, 255)
            }
        }
    }
}

// ============================================================
// 第 6 层：暗角效果（镜头 vignetting）
// ============================================================

/**
 * 添加镜头暗角效果
 *
 * 从画面中心向外亮度递减（边缘降至中心的 70%），使用指数 2.2 模拟
 * 真实镜头 cos⁴ 衰减曲线。每个像素的 R/G/B 通道乘以距离衰减因子。
 */
function addVignette(raw, width, height) {
    const cx = width / 2
    const cy = height / 2
    const maxDist = Math.sqrt(cx * cx + cy * cy)

    for (let y = 0; y < height; y++) {
        const rowStart = y * (width * 4 + 1)
        const dy = (y - cy) / maxDist

        for (let x = 0; x < width; x++) {
            const dx = (x - cx) / maxDist
            const dist = Math.sqrt(dx * dx + dy * dy)
            const factor = 1.0 - 0.30 * Math.pow(dist, 2.2)

            const offset = rowStart + 1 + x * 4
            raw[offset] = clamp(raw[offset] * factor, 0, 255)
            raw[offset + 1] = clamp(raw[offset + 1] * factor, 0, 255)
            raw[offset + 2] = clamp(raw[offset + 2] * factor, 0, 255)
        }
    }
}

// ============================================================
// 主渲染入口
// ============================================================

/**
 * 渲染预览帧（模拟高拍仪实时视频流画面）
 *
 * 特点：纸张有微抖动、中等噪点强度、完整的后处理管线。
 * 分辨率固定为 640×480（与前端 fps 参数匹配）。
 */
function renderPreviewFrame(width, height, frameSeq) {
    const raw = createRawBuffer(width, height)
    fillScannerBed(raw, width, height)
    const paperMeta = drawPaper(raw, width, height, frameSeq)
    drawTemplateContent(raw, width, height, paperMeta, frameSeq)
    addPaperTexture(raw, width, height, paperMeta)
    addSensorNoise(raw, width, height, 7)
    addVignette(raw, width, height)
    return generatePngBase64(width, height, raw)
}

/**
 * 渲染拍照帧（模拟高拍仪快门按下瞬间的捕获画面）
 *
 * 特点：纸张姿态固定无抖动、低噪点、更高分辨率，
 * 模拟真实的 CameraCaptureBase64 指令效果。
 */
function renderCaptureFrame(width, height, devNum) {
    const raw = createRawBuffer(width, height)
    fillScannerBed(raw, width, height)
    const paperMeta = drawPaper(raw, width, height, devNum * 1000)
    drawTemplateContent(raw, width, height, paperMeta, devNum * 1000)
    addPaperTexture(raw, width, height, paperMeta)
    addSensorNoise(raw, width, height, 3)
    addVignette(raw, width, height)
    return generatePngBase64(width, height, raw)
}

module.exports = { renderPreviewFrame, renderCaptureFrame }
