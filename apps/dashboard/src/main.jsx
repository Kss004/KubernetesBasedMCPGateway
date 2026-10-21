import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { Spotlight } from './ui.jsx';
import '@fontsource-variable/jetbrains-mono/wght.css'; // OFL, bundled into fonts/
import './style.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Spotlight />
    <App />
  </StrictMode>,
);
