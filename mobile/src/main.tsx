import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// The service worker caches the shell so the app opens with no signal. API
// responses are deliberately not cached: stale hours would be worse than none,
// and the offline queue is what carries work across a gap.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // registration fails on an insecure origin; the app still works online
    });
  });
}
