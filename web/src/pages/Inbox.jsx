// Classic messenger layout: conversation list on the left, chat on the right.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Search, ArrowLeft, Plus } from 'lucide-react';
import { api } from '../api';
import { subscribe } from '../lib/stream';
import { t } from '../i18n';
import ChatView from '../components/ChatView';
import NewChatModal from '../components/NewChatModal';
import { Avatar, CHANNELS, fmtListTime } from '../components/chatShared';

function waitText(at) {
  const m = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  if (m < 60) return `${m} ${t('min')}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${t('h')} ${m % 60} ${t('min')}`;
  return `${Math.floor(h / 24)} ${t('d')} ${h % 24} ${t('h')}`;
}

function preview(c) {
  if (c.last_deleted_at) return `🚫 ${t('deleted')}`;
  const icon = { image: '📷 ', video: '🎬 ', voice: '🎤 ', audio: '🎵 ', document: '📄 ', sticker: '💟 ', location: '📍 ', contact: '👤 ', template: '📋 ', note: '📝 ' }[c.last_type] || '';
  const text = c.last_text || c.last_media_name || (c.last_type && c.last_type !== 'text' ? t(c.last_type === 'voice' ? 'voice' : c.last_type) : '');
  return `${c.last_direction === 'out' ? `${t('you')}: ` : ''}${icon}${text || '—'}`;
}

export default function Inbox() {
  const { id } = useParams();
  const selectedId = id ? Number(id) : null;
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState(null);
  const [users, setUsers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [filter, setFilter] = useState('all');
  const [channelId, setChannelId] = useState('');
  const [q, setQ] = useState('');
  const [newChat, setNewChat] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    const params = new URLSearchParams({ limit: '100' });
    if (filter !== 'all') params.set('filter', filter);
    if (channelId) params.set('channel_id', channelId);
    if (q.trim()) params.set('q', q.trim());
    const r = await api.get(`/conversations?${params}`);
    if (my === seq.current) { setItems(r.items); setCounts(r.counts); }
  }, [filter, channelId, q]);

  useEffect(() => { const tm = setTimeout(() => load().catch(() => {}), q ? 250 : 0); return () => clearTimeout(tm); }, [load]);
  useEffect(() => { api.get('/users').then(setUsers).catch(() => {}); api.get('/channels').then(setChannels).catch(() => {}); }, []);
  useEffect(() => {
    let tm = null;
    const unsub = subscribe((type) => {
      if (type === 'conversation.updated' || type === 'message.created' || type === 'reconnected') { clearTimeout(tm); tm = setTimeout(() => load().catch(() => {}), 300); }
    });
    return () => { clearTimeout(tm); unsub(); };
  }, [load]);

  const tabs = [['all', t('all')], ['mine', t('mine')], ['unread', t('unread')], ['awaiting', t('awaiting')]];

  return (
    <div className={`inbox${selectedId ? ' has-selection' : ''}`}>
      {newChat && <NewChatModal channels={channels} onClose={() => setNewChat(false)} onStarted={(c) => { setNewChat(false); navigate(`/c/${c.id}`); }} />}
      <aside className="inbox-list">
        <div className="inbox-search">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} />
          <button type="button" className="icon-btn" title={t('new_chat')} onClick={() => setNewChat(true)}><Plus size={18} /></button>
        </div>
        <div className="inbox-tabs">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label}{k === 'unread' && counts?.unread ? <span className="tab-count">{counts.unread}</span> : null}
            </button>
          ))}
        </div>
        {channels.length > 1 && (
          <select className="inbox-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
            <option value="">{t('all_channels')}</option>
            {channels.map((c) => <option key={c.id} value={c.id}>{CHANNELS[c.type]?.label} · {c.account_label || c.name}</option>)}
          </select>
        )}
        <div className="inbox-items">
          {items.map((c) => (
            <button key={c.id} type="button" className={`thread${c.id === selectedId ? ' active' : ''}${c.status === 'closed' ? ' closed' : ''}`} onClick={() => navigate(`/c/${c.id}`)}>
              <Avatar name={c.contact_name} phone={c.contact_phone || c.contact_username} url={c.contact_avatar_url} channel={c.channel_type} />
              <div className="thread-body">
                <div className="thread-top">
                  <span className="thread-name">{c.contact_name || c.contact_phone || c.contact_username || `${CHANNELS[c.channel_type]?.label} ${c.external_id}`}</span>
                  <span className="thread-time">{fmtListTime(c.last_message_at)}</span>
                </div>
                {filter === 'awaiting' && c.last_in_at && <div className="thread-wait">{t('waits', { t: waitText(c.last_in_at) })}</div>}
                <div className="thread-bottom">
                  <span className="thread-preview">{preview(c)}</span>
                  {c.unread_count > 0 && c.id !== selectedId && <span className="unread-pin">{c.unread_count > 99 ? '99+' : c.unread_count}</span>}
                </div>
                {c.assigned_user_name && <div className="thread-assignee">{c.assigned_user_name}</div>}
              </div>
            </button>
          ))}
          {!items.length && <div className="inbox-empty">{filter === 'awaiting' ? t('all_answered') : t('no_conversations')}</div>}
        </div>
      </aside>
      <section className="inbox-chat">
        {selectedId ? (
          <ChatView key={selectedId} conversationId={selectedId} users={users}
            headerExtra={<button type="button" className="btn-ghost back-btn" onClick={() => navigate('/')}><ArrowLeft size={16} /></button>} />
        ) : <div className="inbox-placeholder">{t('pick_conversation')}</div>}
      </section>
    </div>
  );
}
