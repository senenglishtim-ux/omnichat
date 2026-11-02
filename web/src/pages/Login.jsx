import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessagesSquare } from 'lucide-react';
import { api, setSession } from '../api';
import { resetStream } from '../lib/stream';
import { t, getLang, setLang } from '../i18n';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.post('/auth/login', { email, password });
      setSession(r.token, r.user);
      resetStream();
      navigate('/');
    } catch { setErr(t('invalid_credentials')); } finally { setBusy(false); }
  }
  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo"><MessagesSquare size={26} /></div>
        <h1>Omnichat</h1>
        <label className="field">{t('email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></label>
        <label className="field">{t('password')}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {err && <div className="error-text">{err}</div>}
        <button className="primary wide" disabled={busy}>{t('login')}</button>
        <div className="lang-switch">
          <button type="button" className={getLang() === 'ru' ? 'on' : ''} onClick={() => setLang('ru')}>RU</button>
          <button type="button" className={getLang() === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
        </div>
      </form>
    </div>
  );
}
