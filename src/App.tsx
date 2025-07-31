// src/App.tsx
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import HomePage from './pages/HomePage';
import ServerPage from './pages/ServerPage';
import ClientPage from './pages/ClientPage';
import SettingsPage from './pages/SettingsPage';
import ConnectingEventSub from './pages/ConnectingEventSub';
import './App.css';

function App() {
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