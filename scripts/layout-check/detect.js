// 在頁面裡找跑版：文字超出框、文字互相重疊、按鈕文字換行、內容被切掉（不是刻意的 … 省略）
(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const desc = (el) => `${(el.innerText || '').trim() ? '' : '［' + el.outerHTML.slice(0, 80) + '］'}${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''} 「${(el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50)}」`;
  const problems = [];
  const inScroller = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if (o === 'auto' || o === 'scroll') return p; } return null; };
  // 1. 被切掉（沒有 … 的）
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.children.length > 0 && !/^(BUTTON|A|LABEL|TH|TD|SPAN|STRONG|SUMMARY)$/.test(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && el.scrollWidth > el.clientWidth + 2 && cs.textOverflow !== 'ellipsis') problems.push(['被切掉', desc(el)]);
  }
  // 2. 文字超出自己的框、3. 按鈕文字換行
  const texts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); ) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || !visible(el) || el.closest('.folder-term, textarea, .xterm, svg, .door, .blast, details:not([open]) > :not(summary)')) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // 刻意截斷（overflow hidden／…）的：只算框裡看得到的那段
    let clipBox = null;
    for (let p = el; p && p !== document.body; p = p.parentElement) { const pc = getComputedStyle(p); if (pc.overflowX !== 'visible') { clipBox = p.getBoundingClientRect(); break; } }
    const rects = [...range.getClientRects()].map((r) => clipBox ? { left: Math.max(r.left, clipBox.left), right: Math.min(r.right, clipBox.right), top: Math.max(r.top, clipBox.top), bottom: Math.min(r.bottom, clipBox.bottom), width: Math.min(r.right, clipBox.right) - Math.max(r.left, clipBox.left), height: Math.min(r.bottom, clipBox.bottom) - Math.max(r.top, clipBox.top), raw: r } : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, raw: r }).filter((r) => r.width > 1 && r.height > 1);
    if (!rects.length) continue;
    for (const r of rects) {
      if ((r.raw.right > box.right + 2 || r.raw.left < box.left - 2) && cs.overflowX === 'visible' && cs.textOverflow !== 'ellipsis') { problems.push(['文字超出框', desc(el)]); break; }
    }
    // 一個詞（沒有空白的一串，例如 ALL-14796）被拆成兩行
    if (/^[A-Za-z0-9._\-\/:#@]+$/.test(n.textContent.trim()) && n.textContent.trim().length > 1 && new Set(rects.map((r) => Math.round(r.top))).size > 1) problems.push(['詞被拆開', desc(el)]);
    // 整個元素跑出它所在的外框（外框沒有截斷時，會蓋到旁邊的東西）
    for (let c = el, p = el.parentElement; p && p !== document.body; c = p, p = p.parentElement) {
      const pc = getComputedStyle(p); const pr = p.getBoundingClientRect(); const cr = c.getBoundingClientRect();
      if (pc.display === 'contents' || pr.width === 0) continue;
      if (/absolute|fixed/.test(getComputedStyle(c).position)) break; // 浮在外面的下拉選單本來就會超出
      if (cr.right > pr.right + 3 || cr.left < pr.left - 3) { if (pc.overflowX === 'visible') problems.push(['跑出外框', `${desc(c)}  跑出  ${desc(p)}`]); break; }
      if (/^(BODY|MAIN|ASIDE|SECTION)$/.test(p.tagName) || pc.overflowX !== 'visible') break;
    }
    const btn = el.closest('button:not(.ac-head), .tab, summary, th, .status, .mark, .tag, .tab-count');
    if (btn) { const tops = new Set(rects.map((r) => Math.round(r.top))); if (tops.size > 1) problems.push(['換成兩行', desc(btn)]); }
    texts.push({ el, rects, scroller: inScroller(el) });
    // 5. 文字被別的東西蓋住：在文字的幾個點上，最上層的元素不是它自己（或它的上下層）
    const sc = inScroller(el), sb = sc && sc.getBoundingClientRect();
    for (const r of rects) {
      let covered = null;
      for (const fx of [0.15, 0.5, 0.85]) {
        const x = r.left + r.width * fx, y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        if (sb && (y < sb.top || y > sb.bottom)) continue; // 捲到看不見的不算
        const top = document.elementFromPoint(x, y);
        if (!top || top === el || el.contains(top) || top.contains(el)) continue;
        if (top.closest('.more-menu, .skin-panel, .status-menu, [role=menu], .shot-overlay, .door, .blast, .doors') && !el.closest('.more-menu, .skin-panel, .status-menu, [role=menu]')) continue; // 打開的選單蓋住底下是正常的
        covered = top; break;
      }
      if (covered) { problems.push(['被蓋住', `${desc(el)}  被  ${desc(covered)}`]); break; }
    }
  }
  // 4. 不同元素的文字疊在一起
  const clip = (r, s) => { if (!s) return r; const b = s.getBoundingClientRect(); return { left: Math.max(r.left, b.left), right: Math.min(r.right, b.right), top: Math.max(r.top, b.top), bottom: Math.min(r.bottom, b.bottom) }; };
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
    // 浮在上面的選單、提示框蓋住底下是正常的
    const layer = (el) => el.closest('.more-menu, .skin-panel, .status-menu, .pop, [role=menu], details[open] > div, .shot-overlay, .modal, .dialog');
    if (layer(a.el) !== layer(b.el)) continue;
    let hit = false;
    for (const ra0 of a.rects) { const ra = clip(ra0, a.scroller); for (const rb0 of b.rects) { const rb = clip(rb0, b.scroller);
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 3 && h > 3) { hit = true; break; } } if (hit) break; }
    if (hit) problems.push(['文字重疊', `${desc(a.el)}  ↔  ${desc(b.el)}`]);
  }
  // 7. 英文字黏在一起：相鄰兩段文字（不同元素）在同一行，交界兩邊都是英文字母或數字，中間卻沒有空白
  const lastRect = (node) => { const r = document.createRange(); r.selectNodeContents(node); const rs = [...r.getClientRects()].filter((x) => x.width > 0); return rs; };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.closest('details:not([open]) > :not(summary), .folder-term, .xterm, svg, pre, code')) continue;
    const kids = [...el.childNodes].filter((n) => (n.nodeType === 3 && n.textContent.trim()) || (n.nodeType === 1 && visible(n) && n.innerText && n.innerText.trim()));
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i], b = kids[i + 1];
      const at = a.nodeType === 3 ? a.textContent : a.innerText, bt = b.nodeType === 3 ? b.textContent : b.innerText;
      if (/\s$/.test(at) || /^\s/.test(bt)) continue;
      if (!/[A-Za-z0-9)\]]$/.test(at.trimEnd()) || !/^[A-Za-z0-9(\[]/.test(bt.trimStart())) continue;
      // 元素就找裡面最後／最前面的文字，用文字實際的位置比（表格格子之間有留白，不能拿格子的邊界比）
      const edgeText = (node, last) => { if (node.nodeType === 3) return node; const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, { acceptNode: (t) => (t.textContent.trim() ? 1 : 3) }); let t, found = null; while ((t = w.nextNode())) { found = t; if (!last) break; } return found; };
      const ta = edgeText(a, true), tb = edgeText(b, false);
      if (!ta || !tb) continue;
      const ar = lastRect(ta).at(-1), br = lastRect(tb)[0];
      if (!ar || !br || Math.abs(ar.top - br.top) > 4) continue;
      if (br.left - ar.right < 3) problems.push(['英文黏在一起', `${desc(el)}：「${at.trim().slice(-20)}」+「${bt.trim().slice(0, 20)}」`]);
    }
  }
  // 6. 主要區塊出現橫向捲軸（有東西太寬把它撐開了）
  for (const el of document.querySelectorAll('.chat-scroll, aside, main, .tab-body, .panel, .center, .right')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 2) problems.push(['橫向捲軸', desc(el)]);
  }
  const seen = new Set();
  return problems.filter(([k, d]) => { const key = k + d; if (seen.has(key)) return false; seen.add(key); return true; });
})()
