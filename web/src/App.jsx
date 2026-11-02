import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { MessagesSquare, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { getToken, getUser, clearSession } from './api';
import { resetStream } from './lib/stream';
import { t } from './i18n';
import Login from './pages/Login';
import Inbox from './pages/Inbox';
import Settings from './pages/Settings';
import Embed from './pages/Embed';

function Shell({ children }) {
  const navigate = useNavigate();
  const user = getUser();
  return (
    <div className="app-shell">
      <nav className="rail">
        <div className="rail-logo" title="Omnichat"><MessagesSquare size={20} /></div>
        <NavLink to="/" end className="rail-link" title={t('inbox')}><MessagesSquare size={20} /><span>{t('inbox')}</span></NavLink>
        <NavLink to="/settings" className="rail-link" title={t('settings')}><SettingsIcon size={20} /><span>{t('settings')}</span></NavLink>
        <div className="rail-spacer" />
        <button type="button" className="rail-link" title={`${t('logout')} (${user?.name || ''})`} onClick={() => { clearSession(); resetStream(); navigate('/login'); }}>
          <LogOut size={19} /><span>{t('logout')}</span>
        </button>
      </nav>
      <main className="app-main">{children}</main>
    </div>
  );
}

function Private({ children }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/embed/:contactId" element={<Embed />} />
      <Route path="/" element={<Private><Inbox /></Private>} />
      <Route path="/c/:id" element={<Private><Inbox /></Private>} />
      <Route path="/settings/*" element={<Private><Settings /></Private>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
