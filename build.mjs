

/**
 * build.mjs —— 打包为 Chrome/Edge 与 Firefox 两个可加载目录 + zip
 * 用法：node build.mjs
 */
import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 注意：不能用 new URL(import.meta.url).pathname —— 在 Windows 上会得到 "/D:/xxx"，
// 与 path.join 拼接后变成 "D:\D:\xxx"。必须用 fileURLToPath 做跨平台转换。
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TARGETS = [
  { name: 'chrome', manifest: 'manifests/manifest.chrome.json' },
  { name: 'firefox', manifest: 'manifests/manifest.firefox.json' },
];

const STATIC = [
  'rules',
  'icons',
  'src/content/panel.css',
  'src/ui/popup/popup.html',
  'src/ui/popup/popup.js',
  'src/ui/options/options.html',
  'src/ui/options/options.js',
  'LEGAL.md',
  'INSTALL.md',
  'PRIVACY.md',
];

for (const t of TARGETS) {
  const out = path.join(ROOT, 'dist', t.name);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const banner = {
    js: '/* B站评论防和谐 | 作者 @依然匹萨吧 https://space.bilibili.com/6297797 | 非官方工具，详见 LEGAL.md */',
  };
  const common = {
    bundle: true,
    target: ['chrome111', 'firefox115'],
    legalComments: 'inline',
    banner,
    logLevel: 'warning',
  };

  // 内容脚本必须是经典脚本（不支持 ESM），打成 IIFE
  await build({
    ...common,
    entryPoints: ['src/content/main.js'],
    format: 'iife',
    outfile: path.join(out, 'content.js'),
  });

  // 页面世界拦截器：必须是经典脚本，且不依赖任何扩展 API
  await build({
    ...common,
    entryPoints: ['src/core/intercept.js'],
    format: 'iife',
    outfile: path.join(out, 'intercept.js'),
  });

  // 后台为 module 类型，保留 ESM
  await build({
    ...common,
    entryPoints: ['src/bg/service-worker.js'],
    format: 'esm',
    outfile: path.join(out, 'bg.js'),
  });

  for (const s of STATIC) {
    const src = path.join(ROOT, s);
    if (!existsSync(src)) continue;
    await cp(src, path.join(out, s), { recursive: true });
  }

  const mf = JSON.parse(await readFile(path.join(ROOT, t.manifest), 'utf8'));
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(mf, null, 2));
  console.log(`✔ built dist/${t.name}`);
}

/* ---------- 打包为 zip / xpi（纯 Node，跨平台，Windows 无需 zip 命令） ---------- */
if (process.argv.includes('--pack')) {
  const { zipDir } = await import('./zip.mjs');
  const outs = [
    ['chrome',  'biliAntiShadowban-chrome.zip'],
    ['firefox', 'biliAntiShadowban-firefox.zip'],
    ['firefox', 'biliAntiShadowban-firefox.xpi'],
  ];
  for (const [dir, file] of outs) {
    const n = await zipDir(path.join(ROOT, 'dist', dir), path.join(ROOT, 'dist', file));
    console.log(`✔ dist/${file} (${n} 个文件)`);
  }
}



