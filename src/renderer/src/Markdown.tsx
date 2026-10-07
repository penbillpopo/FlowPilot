// AI 的回覆是 Markdown：排版成標題、清單、程式碼區塊。
// 先過濾掉任何可執行的內容，AI 回覆裡就算出現 HTML 也只會被當成文字。
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';

marked.setOptions({ gfm: true, breaks: true });

// 連結一律用外部瀏覽器開，不在 FlowPilot 視窗裡跳頁
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return (
    <div
      className={`markdown ${className ?? ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const link = (e.target as HTMLElement).closest('a');
        if (link?.href.startsWith('https://')) {
          e.preventDefault();
          window.flowpilot.openExternal(link.href);
        }
      }}
    />
  );
}
