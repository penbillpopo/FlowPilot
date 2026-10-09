// 程式碼差異：新增的行綠色、刪除的行紅色
export function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <p className="muted small">（沒有差異內容）</p>;
  const lines = diff.split('\n').filter((line) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line));
  return (
    <pre className="diff">
      {lines.map((line, i) => (
        <div key={i} className={line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
