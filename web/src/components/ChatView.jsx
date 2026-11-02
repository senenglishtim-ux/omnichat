// The chat pane: header, merged feed of every conversation the contact has
// (WhatsApp, Instagram, Telegram... - like a CRM deal chat), composer
// with text / files / voice / templates / notes / replies. Used by the Inbox
// page and by the embeddable widget.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, Mic, Send, Trash2, StickyNote, X, Clock3, MessageCircle, CornerUpLeft, CheckCircle2, RotateCcw } from 'lucide-react';
import { api, uploadWithProgress } from '../api';
import { subscribe } from '../lib/stream';
import { t } from '../i18n';
import MessageBubble from './MessageBubble';
import { AudioPlayer, VideoPlayer } from './MediaPlayers';
import TemplateModal from './TemplateModal';
import { Avatar, ChannelPin, CHANNELS, TemplatesMenu, dayKey, fmtDayLabel, fmtSeconds } from './chatShared';

const PAGE = 60;
const kindOfFile = (f) => (f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : 'document');

export default function ChatView({ conversationId, headerExtra, users = [], embedded }) {
  const [convs, setConvs] = useState([]);           // all conversations of this contact
  const [msgs, setMsgs] = useState({});             // convId -> { items, hasMore }
  const [viaId, setViaId] = useState(conversationId);
  const [pending, setPending] = useState([]);       // local uploads in flight
  const [text, setText] = useState('');
  const [noteMode, setNoteMode] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [tplPick, setTplPick] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [highlight, setHighlight] = useState(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recRef = useRef(null);
  const composerRef = useRef(null);
  const feedRef = useRef(null);
  const loadingOlder = useRef(false);

  const main = convs.find((c) => c.id === conversationId) || convs[0];
  const via = convs.find((c) => c.id === viaId) || main;

  // ---------------------------------------------------------------- loading
  const loadMessages = useCallback(async (cid) => {
    const r = await api.get(`/conversations/${cid}/messages?limit=${PAGE}`);
    setMsgs((s) => ({ ...s, [cid]: { items: r.items, hasMore: r.has_more } }));
  }, []);

  const loadAll = useCallback(async () => {
    const c = await api.get(`/conversations/${conversationId}`);
    const list = (await api.get(`/conversations?contact_id=${c.contact_id}&limit=20`)).items;
    const all = list.some((x) => x.id === c.id) ? list : [c, ...list];
    setConvs(all);
    await Promise.all(all.map((x) => loadMessages(x.id)));
  }, [conversationId, loadMessages]);

  useEffect(() => {
    setConvs([]); setMsgs({}); setPending([]); setReplyTo(null); setErr(''); setViaId(conversationId); setNoteMode(false);
    loadAll().catch((e) => setErr(e.message));
  }, [conversationId, loadAll]);

  useEffect(() => {
    if (!via?.capabilities?.templates) { setTemplates([]); return; }
    api.get(`/templates?channel_id=${via.channel_id}&approved=1`).then(setTemplates).catch(() => setTemplates([]));
  }, [via?.channel_id, via?.capabilities?.templates]);

  // Live updates.
  const convIds = useMemo(() => new Set(convs.map((c) => c.id)), [convs]);
  const contactId = main?.contact_id;
  useEffect(() => subscribe((type, data) => {
    if (type === 'reconnected') { loadAll().catch(() => {}); return; }
    if ((type === 'message.created' || type === 'message.updated') && convIds.has(data.conversation_id)) {
      const m = data.message;
      setMsgs((s) => {
        const cur = s[m.conversation_id] || { items: [], hasMore: false };
        const idx = cur.items.findIndex((x) => x.id === m.id);
        const items = idx >= 0 ? cur.items.map((x) => (x.id === m.id ? m : x)) : [...cur.items, m];
        return { ...s, [m.conversation_id]: { ...cur, items } };
      });
      if (m.client_ref) setPending((p) => p.filter((x) => x.tempId !== m.client_ref));
    }
    if (type === 'conversation.updated') {
      if (data.conversation && convIds.has(data.conversation_id)) setConvs((cs) => cs.map((c) => (c.id === data.conversation_id ? data.conversation : c)));
      else if (data.contact && data.contact_id === contactId) setConvs((cs) => cs.map((c) => ({ ...c, contact_name: data.contact.name, contact_external_ref: data.contact.external_ref })));
      else if (data.conversation && data.contact_id === contactId && !convIds.has(data.conversation_id)) {
        setConvs((cs) => [...cs, data.conversation]);
        loadMessages(data.conversation_id).catch(() => {});
      }
    }
  }), [convIds, contactId, loadAll, loadMessages]);

  // Seen while open = read (clears unread; sends read receipts where the channel supports them).
  const unreadKey = convs.map((c) => `${c.id}:${c.unread_count}`).join(',');
  useEffect(() => {
    const unread = convs.filter((c) => c.unread_count > 0);
    if (!unread.length) return;
    const go = () => { if (document.visibilityState === 'visible') unread.forEach((c) => api.post(`/conversations/${c.id}/read`).catch(() => {})); };
    const tm = setTimeout(go, 400);
    document.addEventListener('visibilitychange', go);
    return () => { clearTimeout(tm); document.removeEventListener('visibilitychange', go); };
  }, [unreadKey]);

  // Older pages when scrolled to the top (the feed is column-reverse).
  async function loadOlder() {
    if (loadingOlder.current) return;
    const targets = convs.filter((c) => msgs[c.id]?.hasMore);
    if (!targets.length) return;
    loadingOlder.current = true;
    try {
      for (const c of targets) {
        const cur = msgs[c.id];
        const r = await api.get(`/conversations/${c.id}/messages?limit=${PAGE}&before=${cur.items[0]?.id || ''}`);
        setMsgs((s) => ({ ...s, [c.id]: { items: [...r.items, ...s[c.id].items.filter((x) => !r.items.some((y) => y.id === x.id))], hasMore: r.has_more } }));
      }
    } finally { loadingOlder.current = false; }
  }
  function onScroll(e) {
    const el = e.currentTarget;
    if (el.scrollHeight + el.scrollTop - el.clientHeight < 300) loadOlder();
  }

  // Grow the composer with its content.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  // ---------------------------------------------------------------- sending
  const windowOpen = !via?.window || via.window.open;
  const canFree = windowOpen || noteMode;

  async function sendText() {
    const value = text.trim();
    if (!value || !via) return;
    setErr(''); setBusy(true);
    const prevReply = replyTo;
    setText(''); setReplyTo(null);
    try {
      if (noteMode) await api.post(`/conversations/${via.id}/notes`, { text: value });
      else await api.post(`/conversations/${via.id}/messages`, { text: value, reply_to_id: prevReply?.id || null });
      if (noteMode) setNoteMode(false);
    } catch (e) {
      setErr(e.message); setText(value); setReplyTo(prevReply);
    } finally {
      setBusy(false);
      composerRef.current?.focus();
    }
  }

  function sendFiles(files, { voice } = {}) {
    if (!via) return;
    const list = [...files];
    const caption = list.length === 1 && !voice ? text.trim() : '';
    if (caption) setText('');
    const reply = replyTo; setReplyTo(null);
    for (const file of list) {
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const kind = voice ? 'voice' : kindOfFile(file);
      const previewUrl = URL.createObjectURL(file);
      const form = new FormData();
      form.append('file', file, file.name || (voice ? 'voice.webm' : 'file'));
      if (caption) form.append('text', caption);
      if (voice) form.append('voice', '1');
      if (reply) form.append('reply_to_id', reply.id);
      form.append('client_ref', tempId);
      const up = uploadWithProgress(`/conversations/${via.id}/messages`, form, (p) => setPending((ps) => ps.map((x) => (x.tempId === tempId ? { ...x, progress: p } : x))));
      setPending((ps) => [...ps, { tempId, convId: via.id, kind, previewUrl, fileName: file.name, size: file.size, caption, progress: 0, status: 'uploading', abort: up.abort }]);
      up.promise.then((m) => {
        setPending((ps) => ps.filter((x) => x.tempId !== tempId));
        if (m?.id) setMsgs((s) => {
          const cur = s[m.conversation_id] || { items: [], hasMore: false };
          return cur.items.some((x) => x.id === m.id) ? s : { ...s, [m.conversation_id]: { ...cur, items: [...cur.items, m] } };
        });
        setTimeout(() => URL.revokeObjectURL(previewUrl), 30000);
      }).catch((e) => {
        if (e.aborted) { setPending((ps) => ps.filter((x) => x.tempId !== tempId)); return; }
        setPending((ps) => ps.map((x) => (x.tempId === tempId ? { ...x, status: 'error', error: e.message } : x)));
      });
    }
  }

  async function sendTemplate(tpl, params) {
    setErr(''); setBusy(true);
    try {
      await api.post(`/conversations/${via.id}/messages`, { template: { name: tpl.name, language: tpl.language, params } });
      setTplPick(null);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function react(m, emoji) {
    setErr('');
    try { await api.post(`/messages/${m.id}/react`, { emoji }); } catch (e) { setErr(e.message); }
  }
  async function retry(m) {
    setErr('');
    try { await api.post(`/messages/${m.id}/retry`); } catch (e) { setErr(e.message); }
  }

  // Voice notes: recorded in the browser (webm/ogg opus), converted on the server per channel.
  async function startRecording() {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4'].find((x) => window.MediaRecorder?.isTypeSupported?.(x)) || '';
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        clearInterval(recRef.current?.timer);
        if (rec._cancelled || !chunks.length) return;
        const type = rec.mimeType || mimeType || 'audio/webm';
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        sendFiles([new File(chunks, `voice.${ext}`, { type: type.split(';')[0] })], { voice: true });
      };
      rec.start();
      recRef.current = { rec, timer: setInterval(() => setRecordSeconds((s) => s + 1), 1000) };
      setRecordSeconds(0); setRecording(true);
    } catch { setErr(t('mic_denied')); }
  }
  function stopRecording(cancel) {
    const r = recRef.current?.rec;
    if (r) { r._cancelled = !!cancel; r.stop(); }
    setRecording(false);
  }
  useEffect(() => () => { const r = recRef.current?.rec; if (r && r.state !== 'inactive') { r._cancelled = true; r.stop(); } }, []);

  function jumpTo(id) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlight(id);
    setTimeout(() => setHighlight(null), 1600);
  }

  async function patchConv(body) {
    try { const c = await api.patch(`/conversations/${main.id}`, body); setConvs((cs) => cs.map((x) => (x.id === c.id ? c : x))); } catch (e) { setErr(e.message); }
  }

  // ---------------------------------------------------------------- feed
  // Entrance animation: items first seen after the initial paint animate once.
  const anim = useRef({ key: null, ready: false, seen: new Set(), entered: new Set() });
  if (anim.current.key !== conversationId) anim.current = { key: conversationId, ready: false, seen: new Set(), entered: new Set() };
  const shouldEnter = (key) => {
    const st = anim.current;
    if (st.entered.has(key)) return true;
    if (st.ready && !st.seen.has(key)) { st.entered.add(key); return true; }
    return false;
  };
  const renderedKeys = [];
  useEffect(() => { renderedKeys.forEach((k) => anim.current.seen.add(k)); if (convs.length) anim.current.ready = true; });

  const multi = convs.length > 1;
  const convById = Object.fromEntries(convs.map((c) => [c.id, c]));
  const feed = convs.flatMap((c) => (msgs[c.id]?.items || [])).sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
  const loadedAll = convs.length > 0 && convs.every((c) => msgs[c.id]);
  const hasMore = convs.some((c) => msgs[c.id]?.hasMore);

  const nodes = [];
  feed.forEach((m, i) => {
    const key = `m-${m.id}`;
    renderedKeys.push(key);
    if (i === 0 || dayKey(m.created_at) !== dayKey(feed[i - 1].created_at)) {
      nodes.push(<div key={`d-${key}`} className="chat-date-divider"><span>{fmtDayLabel(m.created_at)}</span></div>);
    }
    const c = convById[m.conversation_id];
    nodes.push(
      <MessageBubble key={key} m={m} channelType={c?.channel_type} showPin={multi} caps={c?.capabilities}
        canAct={!!c && (!c.window || c.window.open)} enter={shouldEnter(key) && !(m.direction === 'out' && m.client_ref)} highlight={highlight === m.id}
        onReply={(x) => { setReplyTo(x); setViaId(x.conversation_id); composerRef.current?.focus(); }}
        onReact={react} onRetry={retry} onJump={jumpTo} onOpenImage={setLightbox} />
    );
  });
  for (const p of pending) {
    nodes.push(
      <div key={p.tempId} className={`chat-bubble out pending feed-enter${p.status === 'error' ? ' failed' : ''}`}>
        {p.kind === 'image' && <img src={p.previewUrl} alt="" className="chat-media-img" />}
        {p.kind === 'video' && <VideoPlayer src={p.previewUrl} className="chat-media-video" />}
        {(p.kind === 'audio' || p.kind === 'voice') && <AudioPlayer src={p.previewUrl} tone="out" />}
        {p.kind === 'document' && <div className="doc-card"><span className="doc-icon"><Paperclip size={18} /></span><span className="doc-meta"><span className="doc-name">{p.fileName}</span></span></div>}
        {p.caption && <div className="chat-text">{p.caption}</div>}
        <div className="meta">
          {p.status === 'error'
            ? <span>{t('not_sent')}: {p.error} <button type="button" className="link-btn" onClick={() => setPending((ps) => ps.filter((x) => x !== p))}>{t('close')}</button></span>
            : <><span className="upload-bar"><i style={{ width: `${Math.round((p.progress || 0) * 100)}%` }} /></span>{Math.round((p.progress || 0) * 100)}% <button type="button" className="link-btn" onClick={() => p.abort?.()}>{t('cancel')}</button></>}
        </div>
      </div>
    );
  }
  if (loadedAll && !feed.length && !pending.length) {
    nodes.push(<div key="empty" className="chat-empty"><MessageCircle size={28} strokeWidth={1.6} /><div>{t('empty_chat')}</div></div>);
  }
  if (hasMore) nodes.unshift(<button key="older" type="button" className="load-older" onClick={loadOlder}>{t('load_older')}</button>);
  nodes.reverse();

  // ---------------------------------------------------------------- render
  if (!main) return <div className="chat-pane"><div className="chat-loading">{err || <span className="spinner dark" />}</div></div>;

  const hoursLeft = via?.window?.open ? Math.max(1, Math.ceil((new Date(via.window.expires_at) - Date.now()) / 3600e3)) : null;
  const placeholder = noteMode ? t('note_placeholder') : multi ? t('message_in', { c: CHANNELS[via.channel_type]?.label }) : t('message');

  return (
    <div className={`chat-pane${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files') && windowOpen) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files?.length && windowOpen) sendFiles(e.dataTransfer.files); }}>
      {dragOver && <div className="drop-hint">{t('drop_files')}</div>}
      {lightbox && <div className="lightbox" onClick={() => setLightbox(null)}><img src={lightbox} alt="" /><button type="button" className="lightbox-close"><X size={22} /></button></div>}
      {tplPick && <TemplateModal tpl={tplPick} contactName={main.contact_name} busy={busy} onClose={() => setTplPick(null)} onSend={(params) => sendTemplate(tplPick, params)} />}

      <div className="chat-header">
        <Avatar name={main.contact_name} phone={main.contact_phone || main.contact_username} url={main.contact_avatar_url} size={40} />
        <div className="chat-header-info">
          <div className="chat-header-name">{main.contact_name || main.contact_phone || main.contact_username || `${CHANNELS[main.channel_type]?.label} ${main.external_id}`}</div>
          <div className="chat-header-sub">
            {[main.contact_phone, main.contact_username].filter(Boolean).join(' · ')}
            {convs.map((c) => <ChannelPin key={c.id} type={c.channel_type} extra={c.channel_label || c.channel_name} />)}
          </div>
        </div>
        <div className="chat-header-actions">
          {!embedded && users.length > 0 && (
            <select className="assign-select" value={main.assigned_user_id || ''} title={t('assign')} onChange={(e) => patchConv({ assigned_user_id: Number(e.target.value) || null })}>
              <option value="">{t('unassigned')}</option>
              {users.filter((u) => u.is_active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          )}
          {!embedded && (main.status === 'open'
            ? <button type="button" className="btn-ghost" onClick={() => patchConv({ status: 'closed' })} title={t('close_conv')}><CheckCircle2 size={16} /></button>
            : <button type="button" className="btn-ghost" onClick={() => patchConv({ status: 'open' })} title={t('reopen')}><RotateCcw size={16} /></button>)}
          {headerExtra}
        </div>
      </div>

      <div className="chat-feed" ref={feedRef} onScroll={onScroll}>{nodes}</div>

      {err && <div className="chat-error" onClick={() => setErr('')}>{err}</div>}

      <div className="composer">
        {(multi || hoursLeft) && (
          <div className="composer-meta">
            {multi && (
              <div className="via-switch" role="tablist">
                {convs.map((c) => (
                  <button key={c.id} type="button" className={c.id === via.id ? 'on' : ''} onClick={() => setViaId(c.id)}>
                    <i className={`chan-dot-${CHANNELS[c.channel_type]?.cls}`} />{CHANNELS[c.channel_type]?.label}{convs.filter((x) => x.channel_type === c.channel_type).length > 1 ? ` · ${c.channel_label || c.channel_name}` : ''}
                  </button>
                ))}
              </div>
            )}
            {hoursLeft && <span className="composer-window"><Clock3 size={12} /> {t('window_left', { c: CHANNELS[via.channel_type]?.label, h: hoursLeft })}</span>}
          </div>
        )}
        {replyTo && (
          <div className="reply-bar">
            <CornerUpLeft size={15} />
            <div className="reply-bar-text"><b>{replyTo.direction === 'out' ? t('you') : main.contact_name || t('contact')}</b><span>{replyTo.text || replyTo.media_name || replyTo.type}</span></div>
            <button type="button" className="icon-btn" onClick={() => setReplyTo(null)}><X size={16} /></button>
          </div>
        )}
        {recording ? (
          <div className="composer-bar recording">
            <button type="button" className="icon-btn danger" onClick={() => stopRecording(true)} title={t('cancel')}><Trash2 size={17} /></button>
            <span className="record-indicator"><span className="record-dot" /> {fmtSeconds(recordSeconds)}</span>
            <button type="button" className="icon-btn send" onClick={() => stopRecording(false)} title={t('send')}><Send size={17} /></button>
          </div>
        ) : canFree ? (
          <div className={`composer-bar${noteMode ? ' note-mode' : ''}`}>
            {via.capabilities?.templates && !noteMode && <TemplatesMenu templates={templates} disabled={busy} onPick={setTplPick} />}
            <button type="button" className={`icon-btn${noteMode ? ' active' : ''}`} onClick={() => setNoteMode((n) => !n)} title={t('note')}><StickyNote size={18} /></button>
            <textarea ref={composerRef} className="composer-input" rows={1} value={text} placeholder={placeholder}
              onChange={(e) => setText(e.target.value)}
              onPaste={(e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length && !noteMode) { e.preventDefault(); sendFiles(files); } }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendText(); }
                if (e.key === 'Escape') { setReplyTo(null); setNoteMode(false); }
              }} />
            {!noteMode && (
              <label className="icon-btn" title={t('attach')}>
                <input type="file" multiple hidden onChange={(e) => { const f = e.target.files; if (f?.length) sendFiles(f); e.target.value = ''; }} />
                <Paperclip size={19} />
              </label>
            )}
            {text.trim() || noteMode
              ? <button type="button" className="icon-btn send" disabled={busy || !text.trim()} onClick={sendText} title={t('send')}><Send size={17} /></button>
              : via.capabilities?.voice && <button type="button" className="icon-btn" onClick={startRecording} title={t('voice')}><Mic size={19} /></button>}
          </div>
        ) : (
          <div className="composer-bar">
            {via.capabilities?.templates && <TemplatesMenu templates={templates} disabled={busy} onPick={setTplPick} />}
            <button type="button" className="icon-btn" onClick={() => setNoteMode(true)} title={t('note')}><StickyNote size={18} /></button>
            <div className="composer-input composer-placeholder">
              {via.capabilities?.templates ? (feed.length ? t('window_closed_tpl') : t('start_with_template')) : t('window_closed')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
