/**
 * 手搓 ZIP 的工具。
 *
 * 单测与验收脚本共用这一份：造夹具而不是塞一个二进制样本进仓库 —— 夹具的每个字节都能在
 * 代码里读到，而一个 200 字节的 base64 blob 没人能 review。
 */

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

/**
 * 算 CRC32，用于造出真正合法的 ZIP 夹具。
 * @param {Buffer} buffer - 数据
 * @returns {number} 校验值
 */
export function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * 手搓一个 ZIP。
 *
 * 单测里造夹具而不是塞一个二进制样本进仓库：夹具的每个字节都可在测试里读到，
 * 而一个 200 字节的 base64 blob 没人能 review。
 * @param {Array<{ name: string, data: string, deflate?: boolean }>} entries - 条目
 * @returns {Buffer} ZIP 字节
 */
export function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const raw = Buffer.from(entry.data, 'utf8')
    const body = entry.deflate ? deflateRawSync(raw) : raw
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(raw), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(raw), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, eocd])
}
