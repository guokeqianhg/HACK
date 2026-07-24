// 构建前生成 agents/test-officer/_engine-bundle.ts
// 把引擎零依赖文件内容内联成一个被 import 的模块，确保 Makers 部署时一定打包进去。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const FILES = [
  'agent/run-test-officer.mjs', 'agent/select-tests.mjs', 'agent/llm.mjs', 'agent/agent.mjs',
  'agent/officer-tools.mjs', 'agent/live-emitter.mjs', 'agent/glob-shim.mjs', 'agent/check-ui-ready.mjs',
  'report/live-server.mjs', 'report/generate-report.mjs',
];

const entries = FILES.map((f) => {
  const content = fs.readFileSync(path.join(ROOT, f), 'utf-8');
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  return `  ${JSON.stringify(f)}: ${JSON.stringify(b64)}`;
});

const out =
  '// 自动生成，勿手改。由 scripts/bundle-engine.mjs 生成。\n' +
  '// 引擎零依赖文件内容（base64），随 Agent 打包进部署包，运行时写入沙箱。\n' +
  'export const ENGINE_BUNDLE: Record<string, string> = {\n' +
  entries.join(',\n') + '\n};\n';

const target = path.join(ROOT, 'agents', 'test-officer', '_engine-bundle.ts');
fs.writeFileSync(target, out, 'utf-8');
console.log('wrote', target, '(' + FILES.length + ' files, ' + out.length + ' bytes)');
