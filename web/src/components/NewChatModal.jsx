import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { CHANNELS } from './chatShared';

export default function NewChatModal({ channels, onClose, onStarted }) {
  const usable = channels.filter((c) => ['whatsapp_cloud', 'whatsapp_web'].includes(c.type) && c.is_active);
  const [channelId, setChannelId] = useState(usable[0]?.id || '');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true); setErr('');
    try { onStarted(await api.post('/conversations/start', { channel_id: Number(channelId), phone, name: name || null })); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>{t('new_chat')}</b><button type="button" className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        <label className="field">{t('channel')}
          <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            {usable.map((c) => <option key={c.id} value={c.id}>{CHANNELS[c.type].label} · {c.account_label || c.name}</option>)}
          </select>
        </label>
        <label className="field">{t('phone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+7 700 000 00 00" autoFocus /></label>
        <label className="field">{t('name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        {err && <div className="error-text">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="primary" disabled={busy || !phone.trim() || !channelId} onClick={start}>{t('start_chat')}</button>
        </div>
      </div>
    </div>
  );
}
