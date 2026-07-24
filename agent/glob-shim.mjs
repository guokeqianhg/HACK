// glob 兼容垫片
// ---------------------------------------------------------------------------
// 引擎与 select-tests 用到 node:fs 的 globSync（Node >= 22 才内置）。
// EdgeOne Makers 沙箱/部分 CI 仍可能用 Node 18/20，届时
// `import { globSync } from 'node:fs'` 会直接抛
// "does not provide an export named 'globSync'" 导致引擎整体崩溃。
//
// 本垫片：优先用原生 globSync；不可用时回退到同步递归实现，覆盖引擎实际用到的
// 最小 glob 语法：**（递归任意层）/ *（单层通配）/ 字面路径，
// 并支持 { exclude: ['**/node_modules/**'] } 形式的排除。
import fs from 'node:fs';
import path from 'node:path';

let nativeGlob = null;
try {
  nativeGlob = fs.globSync;
} catch {
  nativeGlob = null;
}

// 把 glob 模式转成正则（仅支持 * 与 **，足以覆盖本项目用法）
function toRegex(pattern) {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** 递归
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i += 1; // 吃掉后面的分隔符
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function walk(dir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue; // 默认跳过重型/元数据目录
      walk(full, results);
    } else if (e.isFile()) {
      results.push(full.split(path.sep).join('/'));
    }
  }
}

function fallbackGlob(pattern, opts = {}) {
  // 统一解析为绝对路径，并归一化为正斜杠：
  // walk 产出的路径已被转成正斜杠，正则必须与之对齐（Windows 上 path.resolve 会用反斜杠，直接当字面量会导致全不匹配）
  const absPattern = path.resolve(pattern).split(path.sep).join('/');
  const exclude = (opts.exclude || []).map((p) => toRegex(p.split(path.sep).join('/')));
  const re = toRegex(absPattern);
  const m = absPattern.match(/^(.*?)(?:\*\*|\*)/);
  const baseDir = m ? path.dirname(m[1]) : path.dirname(absPattern);
  const startDir = path.resolve(baseDir || '.');
  const results = [];
  walk(startDir, results);
  return results
    .filter((f) => re.test(f))
    .filter((f) => !exclude.some((rx) => rx.test(f)));
}

export function globSync(pattern, opts) {
  if (typeof nativeGlob === 'function') {
    try {
      return nativeGlob(pattern, opts);
    } catch {
      // 原生调用失败（如选项不兼容）时回退
    }
  }
  return fallbackGlob(pattern, opts || {});
}
