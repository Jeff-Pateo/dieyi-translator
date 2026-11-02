/*
 * 翻译缓存套件（C-40 / 大数据组 F1+F2 护栏）
 * ==================================================================
 * 护什么：
 *   F1 —— stats() 的 approxBytes 必须是 UTF-8 **字节**口径，不是字符数。
 *         中文在 UTF-8 下每字 3 字节，按字符数最多低估 3 倍；设置页直接
 *         把这个数展示成「约 X MB」，口径错了用户就以为离 10MB 配额很远。
 *   F2 —— flush() 落盘失败必须把这一批（写入 + **删除标记**）原样退回
 *         脏队列，下一轮重试。删除标记丢失 ⇒ 已淘汰条目残留 storage ⇒
 *         下次 ensureLoaded 读回内存 ⇒ FIFO 淘汰静默失效。
 *
 * 为什么单独立套件：cache.js 的这两个口径此前没有任何套件覆盖
 * （test-service-worker 只 mock 了 local 的空实现）。
 *
 * 【参数顺序备忘】set(text, source, target, provider, translation, termHash)
 * —— translation 在 termHash **之前**。本套件首版把这两项传反过，
 * 被第四节的 missing 抓了出来。
 *
 * 运行：
 *   NODE_PATH=<node_modules> node tools/test-cache.mjs
 */
import * as cache from '../background/cache.js';

let passCount = 0;
let failCount = 0;
function check(name, cond, detail) {
  if (cond) { passCount++; console.log('  ✓ ' + name + (detail !== undefined ? '  （' + detail + '）' : '')); }
  else { failCount++; console.log('  ✗ ' + name + (detail !== undefined ? '  （' + detail + '）' : '')); }
}

/* 测试侧独立的 UTF-8 字节数（与实现互为对照，不共用实现代码） */
function utf8(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/* ------------------------------------------------------------------
 * 可编程的 chrome.storage.local mock
 * failNextSet/failNextRemove = 让接下来第一次 set/remove 抛错（F2 的注入点）
 * ------------------------------------------------------------------ */
const localStore = new Map();   // key -> value
let failNextSet = false;
let failNextRemove = false;

globalThis.chrome = {
  storage: {
    local: {
      get: async () => {
        // ensureLoaded 走 get(null)：把整个镜像给回去
        const out = {};
        for (const [k, v] of localStore) out[k] = v;
        return out;
      },
      set: async (o) => {
        if (failNextSet) { failNextSet = false; throw new Error('quota: SimulatedChangeFailed'); }
        for (const k of Object.keys(o)) localStore.set(k, o[k]);
      },
      remove: async (keys) => {
        if (failNextRemove) { failNextRemove = false; throw new Error('quota: SimulatedChangeFailed'); }
        for (const k of keys) localStore.delete(k);
      }
    },
    sync: { get: async () => ({}), set: async () => {} }
  }
};

console.log('\n一、stats() 的字节口径（F1）');
{
  await cache.clear();
  const zhTrans = '这是一段纯中文的译文内容，每个字在编码里都占三个字节，字符数口径在这里会整整低估三倍。';
  const asciiTrans = 'plain ascii translation here';
  cache.set('some english source', 'en', 'zh-CN', 'google-free', zhTrans, '0');
  cache.set('another source', 'en', 'zh-CN', 'google-free', asciiTrans, '0');

  const k1 = cache.makeKey('some english source', 'en', 'zh-CN', 'google-free', '0');
  const k2 = cache.makeKey('another source', 'en', 'zh-CN', 'google-free', '0');
  const expected = utf8(k1) + utf8(zhTrans) + 40 + utf8(k2) + utf8(asciiTrans) + 40;
  const s = await cache.stats();
  check('approxBytes 与「UTF-8 键 + UTF-8 译文 + 40」逐字节一致',
    s.approxBytes === expected, s.approxBytes + ' vs 期望 ' + expected);

  const zhChars = zhTrans.length;
  check('纯中文译文按 3 字节/字计入（条目字节 ' + utf8(k1) + '+' + utf8(zhTrans)
    + ' > 字符口径 ' + (utf8(k1) + zhChars) + '）',
    utf8(k1) + utf8(zhTrans) > utf8(k1) + zhChars * 2.5);
}

console.log('\n二、flush() 落盘失败退回脏队列（F2）');
{
  await cache.clear();
  const key = cache.makeKey('flush fail case', 'en', 'zh-CN', 'google-free', '0');
  cache.set('flush fail case', 'en', 'zh-CN', 'google-free', '某条译文', '0');
  failNextSet = true;
  let threw = false;
  try { await cache.flush(); } catch { threw = true; }
  check('注入 set 失败 → flush 如实抛错（不静默吞掉）', threw);
  check('失败后 storage 里没有这条（写入确实没发生）', !localStore.has(key));
  await cache.flush();                            // 第二次：脏队列里应该还有它
  check('重试 flush 后 storage 里有了（脏队列确实退回重入）', localStore.has(key));
}

console.log('\n三、删除标记失败不丢（F2 的核心场景：淘汰不静默失效）');
{
  await cache.clear();
  cache.setLimit(2);                              // 上限压到 2，方便挤爆
  const k1 = cache.makeKey('victim-old', 'en', 'zh-CN', 'google-free', '0');
  const k2 = cache.makeKey('victim-mid', 'en', 'zh-CN', 'google-free', '0');
  cache.set('victim-old', 'en', 'zh-CN', 'google-free', '旧一', '0');
  cache.set('victim-mid', 'en', 'zh-CN', 'google-free', '旧二', '0');
  await cache.flush();                            // 前两条真实落盘
  cache.set('newcomer-entry', 'en', 'zh-CN', 'google-free', '新来的', '0');   // 第 3 条：挤掉 victim-old
  // victim-old 被淘汰 → dirty 标记 null；此时注入 remove 失败
  failNextRemove = true;
  try { await cache.flush(); } catch { /* 预期失败 */ }
  check('注入 remove 失败后，victim-old 仍残留在 storage（失败如实发生）', localStore.has(k1));
  await cache.flush();                            // 重试
  check('重试后 victim-old 从 storage 删除（删除标记没有丢）', !localStore.has(k1));
  check('victim-mid 与 newcomer 都还在（误伤为零）',
    localStore.has(k2) && localStore.has(cache.makeKey('newcomer-entry', 'en', 'zh-CN', 'google-free', '0')));
  // 若删除标记曾丢失，此处的 stats 会把 victim-old 读回来 —— 用 stats 复核
  const s = await cache.stats();
  check('stats 复核：内存镜像只有 2 条（淘汰没被读回）', s.entries === 2, String(s.entries));
}

console.log('\n四、同 key 新脏值不被旧值覆盖（F2 重入的让位规则）');
{
  await cache.clear();
  cache.setLimit(8000);
  const key = cache.makeKey('overlap key', 'en', 'zh-CN', 'google-free', '0');
  cache.set('overlap key', 'en', 'zh-CN', 'google-free', '旧译文', '0');
  failNextSet = true;
  try { await cache.flush(); } catch { /* 失败退回：dirty 里现在是「旧译文」 */ }
  cache.set('overlap key', 'en', 'zh-CN', 'google-free', '新译文', '0');   // flush 失败后同一条又更新了
  await cache.flush();
  const stored = localStore.get(key);
  check('重入不覆盖新值：storage 里是「新译文」', stored && stored.t === '新译文',
    stored ? String(stored.t) : 'missing');
}

console.log('\n────────────────────────────────────────────────────');
console.log(failCount ? '失败 ' + failCount + ' 项，通过 ' + passCount + ' 项' : '全部通过：' + passCount + ' 项断言');
process.exit(failCount ? 1 : 0);
