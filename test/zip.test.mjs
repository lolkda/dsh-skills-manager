import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import test from 'node:test'

import { readZip, safeEntryPath } from '../lib/zip.js'

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
function crc32(buffer) {
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
function makeZip(entries) {
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

test('readZip 读出存储与 deflate 两种条目', () => {
  const buffer = makeZip([
    { name: 'demo/SKILL.md', data: '---\nname: demo\ndescription: x\n---\n正文\n' },
    { name: 'demo/references/a.md', data: '参考内容', deflate: true },
    { name: 'demo/', data: '' },
  ])
  const result = readZip(buffer)
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  const byName = new Map(result.entries.map((e) => [e.name, e]))
  assert.equal(byName.get('demo/SKILL.md').data.toString('utf8').includes('name: demo'), true)
  assert.equal(byName.get('demo/references/a.md').data.toString('utf8'), '参考内容')
  assert.equal(byName.get('demo').isDirectory, true)
})

test('readZip 对损坏与非 ZIP 输入明确失败', () => {
  assert.equal(readZip(Buffer.from('not a zip at all, really')).ok, false)
  const truncated = makeZip([{ name: 'a.md', data: 'x' }]).subarray(0, 20)
  assert.equal(readZip(truncated).ok, false)
})

test('safeEntryPath 挡住 zip-slip 与 Windows 特例', () => {
  assert.equal(safeEntryPath('demo/SKILL.md'), 'demo/SKILL.md')
  assert.equal(safeEntryPath('./demo//x.md'), 'demo/x.md')
  assert.equal(safeEntryPath('demo\\SKILL.md'), 'demo/SKILL.md', '反斜杠必须先统一，否则 ..\\ 能绕过检查')
  assert.equal(safeEntryPath('../evil.md'), null)
  assert.equal(safeEntryPath('..\\..\\evil.md'), null)
  assert.equal(safeEntryPath('/etc/passwd'), 'etc/passwd', '前导斜杠被剥掉，落点仍在根内')
  assert.equal(safeEntryPath('C:/Windows/x'), null)
  assert.equal(safeEntryPath('demo/CON.md'), null)
  assert.equal(safeEntryPath('demo/trailing.'), null)
  assert.equal(safeEntryPath(''), null)
})

test('readZip 拒绝含穿越路径的归档', () => {
  const buffer = makeZip([{ name: '../../evil.md', data: 'x' }])
  const result = readZip(buffer)
  assert.equal(result.ok, false)
  assert.match(result.error, /不安全/)
})
