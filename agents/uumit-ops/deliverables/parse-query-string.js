/**
 * parseQueryString(str) — URL 查询参数解析函数
 * 支持：重复参数合并为数组、中文/URL 编码解码、无参数边界、空值
 * 运行环境：Node.js（也可直接用于浏览器）
 */
'use strict';

/**
 * 解析 URL 查询字符串为对象
 * @param {string} str 查询字符串（可带 ? 前缀，也可传完整 URL）
 * @returns {Object} 解析结果对象。键为参数名，值为 string | string[]
 *   规则：
 *   - 同名参数出现多次 → 合并为数组（保持出现顺序）
 *   - 自动解码 URL 编码（如 %E4%B8%AD → 中），支持 decodeURIComponent 与 + 空格
 *   - 无 `=` 的参数 → 值为 ''（与 URLSearchParams 行为一致）
 *   - 无效编码不抛异常，保留原样
 *   - 空字符串 / 无查询部分 → 返回空对象
 * @example
 *   parseQueryString('a=1&a=2&b=%E4%B8%AD&c=hello+world&flag') 
 *   // → { a: ['1','2'], b: '中', c: 'hello world', flag: '' }
 */
function parseQueryString(str) {
  // 边界：非字符串 / 空串 / 空输入 → 空对象
  if (typeof str !== 'string' || str.length === 0) return {};

  // 兼容传入完整 URL：截取 ? 之后的部分（# 之前）
  let qs = str;
  const qIdx = qs.indexOf('?');
  if (qIdx === -1) {
    // 无 ? 但像 URL（含 :// 或以 / 开头）→ 无查询部分，返回空对象
    if (qs.includes('://') || qs.startsWith('/')) return {};
  } else {
    qs = qs.slice(qIdx + 1);
  }
  const hashIdx = qs.indexOf('#');
  if (hashIdx !== -1) qs = qs.slice(0, hashIdx);
  if (qs.length === 0) return {};

  const result = {};

  for (const pair of qs.split('&')) {
    if (pair.length === 0) continue; // 容忍 'a=1&&b=2' 的空段

    // 按第一个 '=' 分割，避免值里含 '=' 被误切（如 a=b=c → key='a', value='b=c'）
    const eqIdx = pair.indexOf('=');
    let rawKey, rawValue;
    if (eqIdx === -1) {
      rawKey = pair;
      rawValue = ''; // 无 = 的参数视为空值
    } else {
      rawKey = pair.slice(0, eqIdx);
      rawValue = pair.slice(eqIdx + 1);
    }

    const key = safeDecode(rawKey);
    const value = safeDecode(rawValue);

    if (Object.prototype.hasOwnProperty.call(result, key)) {
      // 已存在：合并为数组
      if (Array.isArray(result[key])) {
        result[key].push(value);
      } else {
        result[key] = [result[key], value];
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

/** 安全解码：decodeURIComponent 失败时返回原串（如 '%' 单独出现） */
function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch (e) {
    return s;
  }
}

module.exports = parseQueryString;

// 直接运行本文件时执行自测
if (require.main === module) {
  const assert = require('assert');

  // —— 测试用例 ——
  // 1. 基本解析
  assert.deepStrictEqual(parseQueryString('a=1&b=2'), { a: '1', b: '2' });
  // 2. 重复参数合并为数组（保持顺序）
  assert.deepStrictEqual(parseQueryString('a=1&a=2&a=3'), { a: ['1', '2', '3'] });
  // 3. 中文解码
  assert.deepStrictEqual(parseQueryString('q=%E4%B8%AD%E6%96%87'), { q: '中文' });
  // 4. + 号转空格
  assert.deepStrictEqual(parseQueryString('name=hello+world'), { name: 'hello world' });
  // 5. 值内含 = 不被误切
  assert.deepStrictEqual(parseQueryString('a=b=c'), { a: 'b=c' });
  // 6. 无 = 的参数 → 空字符串
  assert.deepStrictEqual(parseQueryString('flag'), { flag: '' });
  // 7. 带 ? 前缀和 # 片段
  assert.deepStrictEqual(parseQueryString('?x=1#section'), { x: '1' });
  // 8. 完整 URL
  assert.deepStrictEqual(parseQueryString('https://example.com/path?page=2&size=10#top'), { page: '2', size: '10' });
  // 9. 空段容忍
  assert.deepStrictEqual(parseQueryString('a=1&&b=2'), { a: '1', b: '2' });
  // 10. 空串 / 无查询部分
  assert.deepStrictEqual(parseQueryString(''), {});
  assert.deepStrictEqual(parseQueryString('https://example.com/'), {});
  // 11. 无效编码保留原样（不抛异常）
  assert.deepStrictEqual(parseQueryString('bad=%E4%B8'), { bad: '%E4%B8' });
  // 12. 混合：重复 + 中文 + 空值
  assert.deepStrictEqual(
    parseQueryString('tag=a&tag=b&q=%E5%BC%80%E5%8F%91&empty'),
    { tag: ['a', 'b'], q: '开发', empty: '' }
  );
  // 13. 混合 + 空格
  assert.deepStrictEqual(parseQueryString('a=1+2&b=3'), { a: '1 2', b: '3' });

  console.log('✅ 全部 13 组测试用例通过（Node ' + process.version + '）');
}
