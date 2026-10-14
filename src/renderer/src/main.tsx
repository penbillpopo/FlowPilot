import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './skin-allied.css';
import './skin-soviet.css';

// 檔案拖到可以放的地方以外：不要讓視窗把圖片當網頁打開（輸入框自己會處理拖進來的圖片）
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
