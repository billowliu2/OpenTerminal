// 构建垫片:Windows 上安全软件实时扫描新解压的文件时会短暂持有目录句柄(实测 ~4s),
// electron-builder 解包后立即 rename 会撞 EPERM。对 fs.promises 的 rename/rm/unlink/copyFile
// 加 EPERM/EBUSY/ENOTEMPTY 重试(30 次 × 1s),stderr 会打印每次重试。
// 用法(命中 EPERM 时):NODE_OPTIONS="--require $(pwd -W)/scripts/rename-retry-shim.cjs" npm run dist
const fs = require('node:fs');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const MAX_TRIES = 30;
const DELAY_MS = 1000;

function wrap(name) {
  const orig = fs.promises[name];
  if (typeof orig !== 'function') return;
  fs.promises[name] = async function (...args) {
    for (let i = 0; ; i++) {
      try {
        return await orig.apply(fs.promises, args);
      } catch (err) {
        if (!RETRY_CODES.has(err && err.code) || i >= MAX_TRIES - 1) throw err;
        process.stderr.write(`[rename-retry-shim] ${name} ${args[0]} -> ${err.code}, retry ${i + 1}/${MAX_TRIES}\n`);
        await new Promise(r => setTimeout(r, DELAY_MS));
      }
    }
  };
}

wrap('rename');
wrap('rm');
wrap('unlink');
wrap('copyFile');
