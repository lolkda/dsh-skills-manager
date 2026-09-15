/**
 * 最小 ZIP 读取器。
 *
 * 只依赖 `node:zlib`，不引入解压库：导入技能包是本插件唯一需要解压的场景，为一个
 * 32 位小端记录格式拖进一棵依赖树不划算。代价是只支持 store（0）与 deflate（8）
 * 两种压缩方式 —— 那正是 `zip`、7-Zip、Windows 压缩文件夹产出的东西；ZIP64、
 * 加密与 bzip2/lzma 一律明确报错，而不是解出坏的字节。
 *
 * 安全：解压出来的每个路径都必须先过 `safeEntryPath`。ZIP 是外部输入，条目名里写
 * `../../` 或绝对路径就能把文件写到目标目录之外（zip-slip）。这是本仓库里最容易被
 * 滥用的入口，防线就是这一个函数，因此它在写入任何字节之前被逐条调用。
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_COMMENT = 0xffff
const ZIP64_MARKER = 0xffffffff

/** Windows 保留设备名，任何一段撞上它们都会让写入失败或被重定向到设备。 */
const DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * 读取一个 ZIP 归档。
 * @param {Buffer} buffer - 整个文件
 * @returns {{ ok: true, entries: Array<{ name: string, isDirectory: boolean, data: Buffer }> } | { ok: false, error: string }}
 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return { ok: false, error: '文件太小，不是合法的 ZIP' }

  const eocd = findEocd(buffer)
  if (eocd < 0) return { ok: false, error: '找不到 ZIP 中央目录记录（ZIP64 或已损坏的归档本插件不支持）' }

  const count = buffer.readUInt16LE(eocd + 10)
  const directoryOffset = buffer.readUInt32LE(eocd + 16)
  if (directoryOffset === ZIP64_MARKER || count === 0xffff) {
    return { ok: false, error: 'ZIP64 归档本插件不支持，请重新打包为普通 ZIP' }
  }
  if (directoryOffset >= buffer.length) return { ok: false, error: 'ZIP 中央目录偏移越界' }

  const entries = []
  let cursor = directoryOffset
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > buffer.length) return { ok: false, error: 'ZIP 中央目录被截断' }
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return { ok: false, error: 'ZIP 中央目录条目签名不正确' }

    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const rawName = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    const name = safeEntryPath(rawName)
    if (name === null) return { ok: false, error: `ZIP 里含有不安全的条目名：${rawName}` }
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      return { ok: false, error: 'ZIP64 归档本插件不支持，请重新打包为普通 ZIP' }
    }
    if (rawName.endsWith('/') || name === '') {
      entries.push({ name, isDirectory: true, data: Buffer.alloc(0) })
      continue
    }
    if (localOffset + 30 > buffer.length) return { ok: false, error: 'ZIP 局部文件头越界' }
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return { ok: false, error: 'ZIP 局部文件头签名不正确' }
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > buffer.length) return { ok: false, error: 'ZIP 条目数据越界' }

    const raw = buffer.subarray(dataStart, dataEnd)
    let data
    if (method === 0) {
      data = Buffer.from(raw)
    } else if (method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch (error) {
        return { ok: false, error: `解压 ${name} 失败：${error instanceof Error ? error.message : String(error)}` }
      }
    } else {
      return { ok: false, error: `ZIP 条目 ${name} 使用了不支持的压缩方式 ${method}（只支持存储与 deflate）` }
    }
    entries.push({ name, isDirectory: false, data })
  }

  return { ok: true, entries }
}

/**
 * 定位中央目录结束记录。
 * @param {Buffer} buffer - 整个文件
 * @returns {number} EOCD 的偏移，找不到时为 -1
 */
function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - MAX_COMMENT - 22)
  for (let offset = buffer.length - 22; offset >= floor; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * 把 ZIP 条目名规范化成安全的相对路径。
 *
 * 反斜杠先统一成正斜杠：Windows 打包工具会写 `dir\file`，只按 `/` 切分会让 `..\..\x`
 * 整段成为一个「文件名」从而绕过检查，落地时又被文件系统当成路径分隔符。
 * @param {string} rawName - 归档里的原始名字
 * @returns {string|null} 安全的相对路径；不安全时为 null
 */
export function safeEntryPath(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > 512) return null
  const unified = rawName.replace(/\\/g, '/').replace(/^\/+/, '')
  if (unified.includes('\0')) return null
  if (/^[A-Za-z]:/.test(unified)) return null
  const segments = []
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') return null
    // 末尾的点会被 Windows 静默剥掉，从而把 `evil.` 变成 `evil`；直接拒绝。
    if (segment !== segment.replace(/[. ]+$/, '')) return null
    if (DEVICE_NAME_RE.test(segment)) return null
    segments.push(segment)
  }
  return segments.join('/')
}
