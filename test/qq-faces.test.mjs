/**
 * QQ 表情名对照表（`lib/qq-faces.js`）的小测试。
 * 表是数据，最容易“改坏而不自知”，所以钉几条：认识的、不认识的、以及取 id 的优先级。
 */
import assert from 'node:assert/strict'
import { FACE_NAMES, faceName, faceLabel, setCustomFaces, customFaceCount } from '../lib/qq-faces.js'

assert.equal(faceName(0), '微笑')
assert.equal(faceName('12'), '调皮', '字符串 id 也要认')
assert.equal(faceName(9999), null, '不认识的 id 回 null')
assert.equal(faceName(''), null)
assert.equal(faceLabel('6', '0'), '（表情：微笑）', '优先用 faceId')
assert.equal(faceLabel('12'), '（表情：调皮）', '没有 faceId 时用 faceType')
assert.equal(faceLabel('1', '999'), '（表情 #999）', '不认识就写编号，不猜名字')
assert.ok(Object.keys(FACE_NAMES).length >= 100, '常见表情至少收一百个')

// 自定义表：能覆盖内置、能补新 id、能整体清空
setCustomFaces({ 478: '捂脸笑', 0: '别微笑' })
assert.equal(customFaceCount(), 2)
assert.equal(faceName(478), '捂脸笑', '自定义要能补新版 id')
assert.equal(faceName(0), '别微笑', '自定义优先于内置')
setCustomFaces({})
assert.equal(customFaceCount(), 0)
assert.equal(faceName(0), '微笑', '清空后回到内置表')
console.log('qq-faces.test.mjs: all assertions passed')
