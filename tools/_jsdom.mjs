/*
 * 双语助手 · jsdom 解析器
 * ------------------------------------------------------------------
 * 为什么单独抽成一个文件：
 *   扩展目录里【故意不放】 node_modules —— 否则它会被一起打进扩展包，
 *   而 Chrome 加载扩展时要求目录尽量干净（`.crx` 打包也会把它算进去）。
 *   所以 jsdom 走「外部解析」，而不是本地安装。
 *
 * 那么问题来了：外部解析失败时，裸 require('jsdom') 只会吐一段
 * MODULE_NOT_FOUND 堆栈，看不出该做什么。这个文件把那个堆栈换成
 * 一条能照着做的指引，并且按「本地 → 环境变量 → 托管运行时布局」
 * 的顺序自动兜一层，让 npm test 在没设 NODE_PATH 时也能跑起来。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * 解析出所有值得一试的 node_modules 目录。
 * 顺序即优先级：
 *   1) 显式指定的 WB_NODE_MODULES（最高优先，便于自定义）
 *   2) NODE_PATH 里的每一项（Node 原生也认它，这里显式列出只为兜底）
 *   3) 托管 node 运行时的同级 workspace：
 *        <root>/node/versions/<ver>/node.exe  →  <root>/node/workspace/node_modules
 *      注意这个路径是【从 process.execPath 推导】的，不是写死的绝对路径，
 *      所以换机器 / 换 node 版本都不受影响。
 */
function candidateDirs() {
  const dirs = [];

  if (process.env.WB_NODE_MODULES) dirs.push(process.env.WB_NODE_MODULES);

  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) {
      if (p) dirs.push(p);
    }
  }

  // 托管运行时布局推导：.../node/versions/<ver>/node.exe → .../node/workspace/node_modules
  const exeDir = path.dirname(process.execPath);
  dirs.push(path.resolve(exeDir, '..', '..', 'workspace', 'node_modules'));
  // 少数布局下 node 与 workspace 是同级
  dirs.push(path.resolve(exeDir, '..', 'workspace', 'node_modules'));

  return dirs;
}

function die() {
  console.error(
    '\n\u2717 找不到 jsdom —— 五套测试里有两套需要它来跑真实 DOM。\n' +
    '\n' +
    '任选一种方式解决：\n' +
    '\n' +
    '  1) 指向已装好的 node_modules（推荐，不在扩展目录写任何东西）\n' +
    '       NODE_PATH=<某处>/node_modules npm test\n' +
    '\n' +
    '  2) 设置 WB_NODE_MODULES 指向那个 node_modules\n' +
    '       WB_NODE_MODULES=<某处>/node_modules npm test\n' +
    '\n' +
    '  3) 让项目自己装一份（会在扩展目录下生成 node_modules/，仅测试用）\n' +
    '       npm install\n' +
    '\n' +
    '另外三套测试不依赖 jsdom，可以直接跑：\n' +
    '       npm run test:providers && npm run test:worker && npm run test:equiv\n'
  );
  process.exit(1);
}

/** 返回 JSDOM 构造器；找不到就打印指引并以退出码 1 结束。 */
export function loadJsdom() {
  // 先走标准解析：正常 npm install 或有 NODE_PATH 时都会命中。
  try {
    return require('jsdom').JSDOM;
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
  }

  // 再按推导出的候选目录逐个用绝对路径试。
  for (const dir of candidateDirs()) {
    const pkg = path.join(dir, 'jsdom');
    if (!fs.existsSync(pkg)) continue;
    try {
      return require(pkg).JSDOM;
    } catch (err) {
      // 这个目录里有 jsdom 但加载不起来（多为二进制依赖缺失），
      // 继续试下一个，不要在这里就放弃。
    }
  }

  die();
}

export const JSDOM_DIRS_HINT = candidateDirs();
