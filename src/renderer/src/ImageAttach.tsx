// 附圖：「截圖」（跟 ⌘⇧4 一樣拖範圍，截完可以畫線、打字）、「附圖」按鈕選檔、拖曳進來（有沒有按 Shift 都可以）、直接貼上。存到本機後給 AI 看，輸入框上方顯示縮圖、可以拿掉。
import { useRef, useState } from 'react';
import { ScreenshotEditor } from './ScreenshotEditor';
import { t } from '../../shared/i18n';

const api = window.flowpilot;

export interface ImageAttach {
  images: string[];
  clear(): void;
  /** 掛在輸入框（或包住輸入框的區塊）上：貼上、拖曳 */
  bind: {
    onPaste(e: React.ClipboardEvent): void;
    onDragOver(e: React.DragEvent): void;
    onDragLeave(): void;
    onDrop(e: React.DragEvent): void;
  };
  dragging: boolean;
  /** 縮圖列＋「附圖」按鈕 */
  view: React.ReactNode;
  pickButton: React.ReactNode;
}

export function useImageAttach(): ImageAttach {
  const [images, setImages] = useState<{ path: string; preview: string }[]>([]);
  const [dragging, setDragging] = useState(false);
  /** 截好、正在編輯的圖 */
  const [shot, setShot] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);

  async function capture() {
    setShooting(true);
    try {
      const result = await api.captureScreen();
      if (result) setShot(result.dataUrl);
    } finally {
      setShooting(false);
    }
  }
  const picker = useRef<HTMLInputElement>(null);

  async function add(files: File[]) {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      const path = await api.saveImage(await file.arrayBuffer(), file.type.split('/')[1] ?? 'png');
      setImages((prev) => [...prev, { path, preview: URL.createObjectURL(file) }]);
    }
  }

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');

  return {
    images: images.map((i) => i.path),
    clear: () => setImages([]),
    dragging,
    bind: {
      onPaste(e) {
        const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
        if (!files.length) return;
        e.preventDefault();
        void add(files);
      },
      onDragOver(e) {
        if (!hasFiles(e)) return;
        e.preventDefault(); // 允許放下（否則 Electron 會把圖片當網頁打開）
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      },
      onDragLeave() {
        setDragging(false);
      },
      onDrop(e) {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        void add([...e.dataTransfer.files]);
      },
    },
    pickButton: (
      <>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <button type="button" className="attach-button" disabled={shooting} title={t('跟 ⌘⇧4 一樣拖一塊範圍；要截被擋住的視窗，按空白鍵再點那個視窗；Esc 取消。截完可以畫線、加框、箭頭、打字')} onClick={capture}>
          {shooting ? t('截圖中…') : t('截圖')}
        </button>
        <button type="button" className="attach-button" title={t('附上圖片（也可以拖曳進輸入框或直接貼上）')} onClick={() => picker.current?.click()}>
          {t('附圖')}
        </button>
        {shot && (
          <ScreenshotEditor
            src={shot}
            onCancel={() => setShot(null)}
            onDone={(png) => {
              setShot(null);
              void add([new File([png], 'screenshot.png', { type: 'image/png' })]);
            }}
          />
        )}
      </>
    ),
    view: images.length > 0 && (
      <div className="attach-thumbs">
        {images.map((img, i) => (
          <span key={img.path} className="attach-thumb" title={img.path}>
            <img src={img.preview} alt={t('圖片 {n}', { n: i + 1 })} />
            <button className="link" title={t('拿掉')} onClick={() => setImages((prev) => prev.filter((p) => p.path !== img.path))}>×</button>
          </span>
        ))}
      </div>
    ),
  };
}
