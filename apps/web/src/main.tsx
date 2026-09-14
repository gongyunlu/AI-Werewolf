import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { applyStoredTheme } from './lib/theme';

// 挂类名要在首屏渲染之前，否则选了白天的用户会先看到一帧深色
applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
