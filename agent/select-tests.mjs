// 通用「精准选测」模块（场景 A / P2）
// 设计原则：完全不依赖被测业务语义，只基于仓库结构做通用启发式，
// 对任何 repo 都可复用，避免对特定场景（如本仓库的 coupon/inventory）过拟合。
//
// 选测逻辑（由宽到窄，命中即收）：
//   1. 无改动 / 改动含全局影响文件 / 无法关联 → 回退全量
//   2. 直接改了测试文件 → 必跑该测试
//   3. 改了源码 → 用「导入图反向可达」找出所有（传递）依赖它的测试
//   4. 同名/同干（stem）兜底：src/foo.js ↔ tests/foo.test.js
//
// 依赖图仅在本仓库被测目录（repoDir）内构建，自动排除 node_modules。

import fs from 'node:fs';
import path from 'node:path';
import { globSync } from 'node:fs';

const TEST_RE = /\.(test|spec)\.[mc]?js$/;
const SOURCE_RE = /\.[mc]?js$/; // 仅把 js 系当源码（测试也是 js，但被 TEST_RE 排除）

export function isTestFile(p) {
  return TEST_RE.test(p);
}
export function isSourceFile(p) {
  return SOURCE_RE.test(p) && !TEST_RE.test(p);
}

function stemOf(p) {
  let b = path.basename(p).replace(/\.[mc]?js$/, '');
  return b.replace(/\.(test|spec)$/, '');
}

function resolveImport(spec, fromDir) {
  if (!spec || spec.startsWith('.')) {
    const base = path.resolve(fromDir, spec);
    for (const t of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
      try { if (fs.statSync(t).isFile()) return path.resolve(t); } catch { /* noop */ }
    }
  }
  return null; // 跳过裸模块名（node_modules/内置），不影响通用性
}

function allJsFiles(repoDir) {
  const out = [];
  for (const g of ['**/*.js', '**/*.mjs', '**/*.cjs']) {
    out.push(...globSync(path.join(repoDir, g), { exclude: ['**/node_modules/**'] }));
  }
  return [...new Set(out.map((f) => path.resolve(f)))];
}

function importsOf(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const deps = [];
  const re = /(?:import\s+(?:[^'"]*\s+from\s+)?|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const r = resolveImport(m[1], path.dirname(file));
    if (r) deps.push(path.resolve(r));
  }
  return deps;
}

// 在被测目录内构建导入图，并求「能传递依赖 target 的所有文件」
function reverseReachableTests(repoDir, targetAbs) {
  const files = allJsFiles(repoDir);
  const graph = new Map();
  for (const f of files) graph.set(f, new Set(importsOf(f)));

  const rev = new Map();
  for (const [f, deps] of graph) {
    for (const d of deps) {
      if (!rev.has(d)) rev.set(d, new Set());
      rev.get(d).add(f);
    }
  }
  const reached = new Set();
  const seen = new Set();
  const stack = [path.resolve(targetAbs)];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const up of rev.get(cur) || []) {
      reached.add(up);
      stack.push(up);
    }
  }
  return reached;
}

// 全局影响文件：改动它们应回退全量（通用基础设施感知，非业务硬编码）
const BROAD_IMPACT = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig.*\.json|jsconfig\.json|jest\.config.*|vitest\.config.*|vite\.config.*|webpack.*|rollup.*|esbuild.*|babel\.config.*|Makefile|Dockerfile|\.github[\\/].*|\.gitlab-ci\.yml|build\.(js|sh|ps1))$/i;

// changedFiles: 来自 git diff，路径相对于 git 仓库根（可能含 SUT 子目录前缀）
// repoDir: 实际被测目录（绝对）；gitRoot: git 仓库根（绝对）
export function selectTests({ repoDir, gitRoot, changedFiles }) {
  const allTests = allJsFiles(repoDir).filter(isTestFile);
  if (!changedFiles || changedFiles.length === 0) {
    return { testFiles: allTests, narrowed: false, reason: '无改动（全量回归）' };
  }

  const repoRel = path.relative(gitRoot, repoDir); // SUT 相对 git 根，可能为空
  const inSut = (f) => {
    const rel = path.relative(repoRel, f);
    return rel.startsWith('..') ? null : path.resolve(repoDir, rel);
  };

  const broad = changedFiles.filter((f) => BROAD_IMPACT.test(f));
  if (broad.length) {
    return { testFiles: allTests, narrowed: false, reason: `含全局影响文件（${broad.join(', ')}），回退全量回归` };
  }

  const changedTestAbs = [];
  const changedSrcAbs = [];
  for (const f of changedFiles) {
    const abs = inSut(f);
    if (!abs) continue;
    if (isTestFile(abs)) changedTestAbs.push(abs);
    else if (isSourceFile(abs)) changedSrcAbs.push(abs);
  }

  const picked = new Set(changedTestAbs);

  // 启发式 3：导入图反向可达（传递依赖）
  for (const s of changedSrcAbs) {
    for (const t of reverseReachableTests(repoDir, s)) {
      if (isTestFile(t)) picked.add(t);
    }
  }

  // 启发式 4：同名/同干兜底
  for (const s of changedSrcAbs) {
    const stem = stemOf(s);
    for (const t of allTests) {
      const ts = stemOf(t);
      if (ts === stem || ts.startsWith(stem) || stem.startsWith(ts)) picked.add(t);
    }
  }

  const pickedArr = [...picked];
  if (!pickedArr.length) {
    return { testFiles: allTests, narrowed: false, reason: '未能将改动关联到测试，回退全量回归' };
  }
  return {
    testFiles: pickedArr,
    narrowed: true,
    reason: `按导入图/同名关联出 ${pickedArr.length}/${allTests.length} 个测试文件`,
  };
}
