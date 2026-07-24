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
import { globSync } from './glob-shim.mjs'; // 兼容垫片：Node<22 也能用 glob

const TEST_RE = /\.(test|spec)\.[mc]?js$/;
// 本执行引擎用 `node --test` 跑测，只认 node 原生测试文件（*.test.js / *-test.js / test-*.js）。
// *.spec.js 是 Playwright/Vitest 等框架的通行约定，需其独立 runner，不能交给 node --test。
// 此举基于「测试运行器约定」做通用过滤，不针对任何具体业务场景。
export function isRunnableTest(p) {
  const b = path.basename(p);
  return /\.(test)\.[mc]?js$/.test(b) || /(^|[-_])test\.[mc]?js$/.test(b) || /^test-.*\.[mc]?js$/.test(b);
}
const SOURCE_RE = /\.[mc]?js$/; // 仅把 js 系当源码（测试也是 js，但被 TEST_RE 排除）

export function isTestFile(p) {
  return TEST_RE.test(p);
}
export function isSourceFile(p) {
  return SOURCE_RE.test(p) && !TEST_RE.test(p);
}

export function stemOf(p) {
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

// 在被测目录内构建导入图（一次），返回反向索引 rev：rev.get(文件) = 所有（传递）依赖它的文件
// 整个 selectTests 只调用一次，避免对每个改动源文件重复扫描全仓库（O(n·m) → O(n+m)）
function buildImportGraph(repoDir) {
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
  return { files, rev };
}

// 从 targetAbs 出发，沿反向依赖图传递求「能依赖它的所有文件」
function reverseReachableFrom(rev, targetAbs) {
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

// 需求/缺陷 → 测试覆盖度 用的「模块直接对应测试」：
// 返回与 moduleRel 同干（stem）的可运行测试文件（如 src/coupon.js ↔ tests/coupon.test.js）。
// 仅用同干匹配（不做传递反查），避免把「被其它模块 bug 牵连失败的测试」误算进本模块的覆盖度。
export function testsForModule(repoDir, moduleRel) {
  const modStem = stemOf(moduleRel);
  return allJsFiles(repoDir).filter(isRunnableTest).filter((t) => stemOf(t) === modStem);
}

// ---------- 自适应策略用：失败后「扩展选测」----------
// 给定一组（首轮失败的）测试文件，找出「与这些测试共享源码依赖、但首轮未跑到」的其它可运行测试。
// 价值：首轮精准选测可能漏掉「间接依赖同一源码模块」的测试（隐性影响面），失败后据此扩展，
// 把原本会漏报的关联失败暴露出来。仅基于导入图，不依赖任何业务语义。
//   testFiles : 失败的测试文件绝对路径数组
//   alreadyRun: 首轮已跑的测试文件绝对路径数组（会被排除，避免重复）
//   limit    : 最多扩展多少个（防止失败测试依赖了被广泛使用的基础模块而爆炸）
export function expandTests(repoDir, testFiles, alreadyRun = [], limit = 40) {
  const { files, rev } = buildImportGraph(repoDir);
  const already = new Set([...alreadyRun, ...testFiles].map((f) => path.resolve(f)));
  const seeds = testFiles.map((f) => path.resolve(f));
  // 1) 反查失败测试 import 的源码模块
  const srcModules = new Set();
  for (const t of seeds) for (const dep of importsOf(t)) srcModules.add(dep);
  // 2) 再从这些源码模块反向可达，收集所有依赖它们的测试
  const related = new Set();
  for (const s of srcModules) {
    for (const up of reverseReachableFrom(rev, s)) {
      if (isRunnableTest(up) && !already.has(up)) related.add(up);
    }
  }
  return [...related].slice(0, limit);
}

// 全局影响文件：改动它们应回退全量（通用基础设施感知，非业务硬编码）。
// 注意：package.json / 各类 lock 文件只改变依赖环境，不改变"应跑哪些测试"，
// 若把它们算作全局影响会无谓触发全量回归（尤其被测仓库是父仓库子目录时易误伤），故排除。
const BROAD_IMPACT = /(^|\/)(tsconfig.*\.json|jsconfig\.json|jest\.config.*|vitest\.config.*|vite\.config.*|webpack.*|rollup.*|esbuild.*|babel\.config.*|Makefile|Dockerfile|\.github[\\/].*|\.gitlab-ci\.yml|build\.(js|sh|ps1))$/i;

// changedFiles: 来自 git diff，路径相对于 git 仓库根（可能含 SUT 子目录前缀）
// repoDir: 实际被测目录（绝对）；gitRoot: git 仓库根（绝对，可选旧式入参）
// repoRel: SUT 相对 git 根的前缀（推荐：由调用方用 git rev-parse --show-prefix 算好传入，
//   规避 Windows 8.3 短名路径与 git 长名路径字符串相对化失败的问题）；不传则回退旧逻辑。
export function selectTests({ repoDir, gitRoot, changedFiles, repoRel: repoRelOpt }) {
  // 可运行全集：仅 node --test 能跑的文件（排除 *.spec.js 等需独立 runner 的框架文件）
  // 复用 buildImportGraph 已扫描的全仓库文件清单，避免重复全量扫描
  const { files, rev } = buildImportGraph(repoDir);
  const runnable = files.filter(isRunnableTest);
  if (!changedFiles || changedFiles.length === 0) {
    return { testFiles: runnable, narrowed: false, reason: '无改动（全量回归）' };
  }

  const repoRel = repoRelOpt !== undefined ? repoRelOpt : path.relative(gitRoot, repoDir); // SUT 相对 git 根，可能为空
  const inSut = (f) => {
    const rel = path.relative(repoRel, f);
    return rel.startsWith('..') ? null : path.resolve(repoDir, rel);
  };

  const broad = changedFiles.filter((f) => BROAD_IMPACT.test(f));
  if (broad.length) {
    return { testFiles: runnable, narrowed: false, reason: `含全局影响文件（${broad.join(', ')}），回退全量回归` };
  }

  const changedTestAbs = [];
  const changedSrcAbs = [];
  for (const f of changedFiles) {
    const abs = inSut(f);
    if (!abs) continue;
    if (isTestFile(abs)) changedTestAbs.push(abs);
    else if (isSourceFile(abs)) changedSrcAbs.push(abs);
  }

  const picked = new Set(changedTestAbs.filter(isRunnableTest));

  // 启发式 3：导入图反向可达（传递依赖）—— 复用上面已构建的 rev 图
  for (const s of changedSrcAbs) {
    for (const t of reverseReachableFrom(rev, s)) {
      if (isRunnableTest(t)) picked.add(t);
    }
  }

  // 启发式 4：同名/同干兜底
  for (const s of changedSrcAbs) {
    const stem = stemOf(s);
    for (const t of runnable) {
      const ts = stemOf(t);
      if (ts === stem || ts.startsWith(stem) || stem.startsWith(ts)) picked.add(t);
    }
  }

  const pickedArr = [...picked];
  if (!pickedArr.length) {
    return { testFiles: runnable, narrowed: false, reason: '未能将改动关联到测试，回退全量回归' };
  }
  return {
    testFiles: pickedArr,
    narrowed: true,
    reason: `按导入图/同名关联出 ${pickedArr.length}/${runnable.length} 个测试文件`,
  };
}

// 列出仓库内全部可运行/接口/UI 测试（供 Agent 的 list_test_files 工具使用）。
// 返回 [{ rel, abs, kind }]，kind: unit | api | ui（按路径/文件名通用判定，不依赖业务）。
export function listAllTests(repoDir) {
  const out = [];
  for (const abs of allJsFiles(repoDir)) {
    const rel = path.relative(repoDir, abs);
    const b = path.basename(abs);
    let kind = 'unit';
    if (/api-smoke|smoke\/api/i.test(rel)) kind = 'api';
    else if (/ui-smoke|smoke\/ui/i.test(rel)) kind = 'ui';
    else if (!isRunnableTest(abs)) kind = 'other';
    if (kind === 'other') continue;
    out.push({ rel, abs, kind });
  }
  return out;
}
