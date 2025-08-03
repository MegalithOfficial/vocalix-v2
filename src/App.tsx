// src/App.tsx
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import HomePage from './pages/HomePage';
import ServerPage from './pages/ServerPage';
import ClientPage from './pages/ClientPage';
import SettingsPage from './pages/SettingsPage';
import ConnectingEventSub from './pages/ConnectingEventSub';
import './App.css';
import { useSettingsState } from './hooks/useSettingsState';

function App() {
  const settingsState = useSettingsState();
  const { setOnlyClientMode } = settingsState;

  useEffect(() => {
    let unlisten: undefined | (() => void);
    (async () => {
      try {
        unlisten = await listen<boolean>('CLIENT_ONLY_MODE', (evt) => {
          setOnlyClientMode(Boolean(evt.payload));
        });
      } catch (e) {
        console.error('CLIENT_ONLY_MODE listen failed', e);
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [setOnlyClientMode]);

  return (
    <Router>
      <AnimatePresence mode="wait">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/server" element={<ServerPage />} />
          <Route path="/client" element={<ClientPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/connecting-eventsub" element={<ConnectingEventSub />} />
        </Routes>
      </AnimatePresence>
    </Router>
  );
}

export default App;