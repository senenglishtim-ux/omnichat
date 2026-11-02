// One message in the feed - every type a channel can deliver, rendered the
// way messengers do: media inline, voice as a waveform, documents as a file
// card, locations/contacts as cards, quoted replies, reactions, ticks.
import { memo } from 'react';
import { CornerUpLeft, FileText, MapPin, User, RotateCw, Forward, Ban, StickyNote, PhoneIncoming, Download } from 'lucide-react';
import { t } from '../i18n';
import { fileUrl } from '../api';
import { AudioPlayer, VideoPlayer } from './MediaPlayers';
import { ChannelPin, Linkify, Ticks, ReactionBadge, ReactionPicker, fmtHM, fmtSize, DEFAULT_REACTIONS } from './chatShared';

const kindOf = (m) => {
  const mime = (m.media_mime || '').toLowerCase();
  if (m.type === 'sticker') return mime.startsWith('video/') ? 'sticker-video' : 'sticker';
  if (m.type === 'voice') return 'voice';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (['image', 'video', 'audio'].includes(m.type) && !mime) return m.type;
  return 'document';
};

function Media({ m, onOpenImage }) {
  const tone = m.direction === 'out' ? 'out' : 'in';
  if (m.media_status === 'pending') {
    if (m.type === 'voice' || m.type === 'audio') return <div className={`ap ap-${tone} ap-skeleton`}><span className="ap-btn" /><div className="ap-main"><div className="ap-wave" /></div></div>;
    return <div className="media-skeleton">{t('loading')}</div>;
  }
  if (m.media_status === 'failed' || !m.media_url) {
    return <div className="media-failed" title={m.media_error || ''}>⚠ {t('media_failed')}{m.media_error ? `: ${m.media_error}` : ''}</div>;
  }
  const url = fileUrl(m.media_url);
  const k = kindOf(m);
  if (k === 'sticker') return <img src={url} alt={t('sticker')} className="chat-sticker" loading="lazy" />;
  if (k === 'sticker-video') return <video src={url} className="chat-sticker" autoPlay loop muted playsInline />;
  if (k === 'image') return <img src={url} alt="" className="chat-media-img" loading="lazy" onClick={() => onOpenImage?.(url)} />;
  if (k === 'video') return <VideoPlayer src={url} className="chat-media-video" round={m.payload?.round} gif={m.payload?.gif} />;
  if (k === 'voice' || k === 'audio') {
    return <>
      {k === 'audio' && m.media_name && <div className="audio-name">{m.media_name}</div>}
      <AudioPlayer src={url} tone={tone} download={`${url}&download=1`} />
    </>;
  }
  return (
    <a className="doc-card" href={`${url}&download=1`} download={m.media_name || true}>
      <span className="doc-icon"><FileText size={20} /></span>
      <span className="doc-meta">
        <span className="doc-name">{m.media_name || t('document')}</span>
        <span className="doc-size">{[fmtSize(m.media_size), (m.media_name || '').split('.').pop()?.toUpperCase()].filter(Boolean).join(' · ')}</span>
      </span>
      <Download size={16} className="doc-dl" />
    </a>
  );
}

function Location({ p }) {
  const l = p?.location || {};
  const href = `https://www.openstreetmap.org/?mlat=${l.latitude}&mlon=${l.longitude}#map=16/${l.latitude}/${l.longitude}`;
  return (
    <a className="card-link" href={href} target="_blank" rel="noreferrer">
      <span className="card-icon"><MapPin size={18} /></span>
      <span>
        <b>{l.name || (l.live ? t('live_location') : t('open_map'))}</b>
        {l.address && <span className="card-sub">{l.address}</span>}
        <span className="card-sub">{Number(l.latitude).toFixed(5)}, {Number(l.longitude).toFixed(5)}</span>
      </span>
    </a>
  );
}

function Contacts({ p }) {
  return (p?.contacts || []).map((c, i) => (
    <div key={i} className="card-link">
      <span className="card-icon"><User size={18} /></span>
      <span>
        <b>{c.name || t('contact_card')}</b>
        {(c.phones || []).map((ph) => <a key={ph} className="card-sub" href={`tel:${ph}`}>{ph}</a>)}
        {(c.emails || []).map((e) => <a key={e} className="card-sub" href={`mailto:${e}`}>{e}</a>)}
      </span>
    </div>
  ));
}

function Quote({ r, onJump }) {
  if (!r) return null;
  const label = r.text || r.media_name || ({ image: '📷', video: '🎬', voice: '🎤', audio: '🎵', document: '📄', sticker: t('sticker'), location: '📍' }[r.type] || '…');
  return (
    <button type="button" className={`chat-quote ${r.direction}`} onClick={(e) => { e.stopPropagation(); onJump?.(r.id); }}>
      <span className="chat-quote-who">{r.direction === 'out' ? t('you') : t('contact')}</span>
      <span className="chat-quote-text">{label}</span>
    </button>
  );
}

function MessageBubble({ m, channelType, showPin, caps, canAct, onReply, onReact, onRetry, onJump, onOpenImage, enter, highlight }) {
  if (m.direction === 'note') {
    return (
      <div id={`msg-${m.id}`} className={`chat-note${enter ? ' feed-enter' : ''}`}>
        <div className="chat-note-head"><StickyNote size={13} /> {m.sender_name || m.sender_label || t('note')} · {fmtHM(m.created_at)}</div>
        <div className="chat-text"><Linkify text={m.text} /></div>
      </div>
    );
  }
  if (m.type === 'system') {
    return <div id={`msg-${m.id}`} className={`chat-event${enter ? ' feed-enter' : ''}`}><PhoneIncoming size={12} /> {m.text} · {fmtHM(m.created_at)}</div>;
  }
  const out = m.direction === 'out';
  const isSticker = m.type === 'sticker' && m.media_url;
  const hasMedia = !!(m.media_path || m.media_status) && m.type !== 'location';
  const reactions = caps?.reactions ? (Array.isArray(caps.reactions) ? caps.reactions : DEFAULT_REACTIONS) : null;
  const sub = m.sender_label === 'phone' ? t('from_phone') : m.sender_label || null;
  const cls = ['chat-bubble', out ? 'out' : 'in'];
  if (isSticker) cls.push('sticker');
  if (m.status === 'failed') cls.push('failed');
  if (m.reaction_in || m.reaction_out) cls.push('has-reaction');
  if (m.deleted_at) cls.push('deleted');
  if (enter) cls.push('feed-enter');
  if (highlight) cls.push('highlight');
  if (hasMedia && !m.text && !m.reply_to && ['image', 'video'].includes(m.type)) cls.push('media-only');

  return (
    <div id={`msg-${m.id}`} className={cls.join(' ')}>
      {showPin && <ChannelPin type={channelType} />}
      {m.payload?.forwarded && <div className="chat-flag"><Forward size={12} /> {t('forwarded')}</div>}
      {m.payload?.story_reply && <div className="chat-flag">{t('story_reply')}</div>}
      {m.payload?.story_mention && <div className="chat-flag">{t('story_mention')}</div>}
      {m.type === 'template' && <div className="chat-flag">{t('template')}{m.payload?.template?.name ? ` · ${m.payload.template.name}` : ''}</div>}
      <Quote r={m.reply_to} onJump={onJump} />
      {m.deleted_at && <div className="chat-flag deleted"><Ban size={12} /> {t('deleted')}</div>}
      {hasMedia && <Media m={m} onOpenImage={onOpenImage} />}
      {m.type === 'location' && <Location p={m.payload} />}
      {m.type === 'contact' && <Contacts p={m.payload} />}
      {m.type === 'sticker' && !m.media_path && !m.media_status && <div className="chat-sticker-emoji">{m.payload?.emoji || m.text}</div>}
      {m.text && !['location', 'contact'].includes(m.type) && !(m.type === 'sticker' && !m.media_path) && (
        <div className={`chat-text${m.type === 'unsupported' ? ' muted' : ''}`}><Linkify text={m.text} /></div>
      )}
      <div className="meta">
        {m.edited_at && <span className="meta-edited">{t('edited')} · </span>}
        {fmtHM(m.created_at)}
        {out && (m.sender_name || sub) ? ` · ${m.sender_name || sub}` : ''}
        {out && channelType === 'telegram' && m.status === 'sent' ? <span className="ticks-tg" title={t('accepted_tg')}> ✓</span> : out && <Ticks status={m.status} error={m.error} />}
      </div>
      {m.status === 'failed' && (
        <div className="chat-failed">
          <span title={m.error || ''}>{t('not_sent')}{m.error ? `: ${m.error}` : ''}</span>
          {onRetry && <button type="button" onClick={() => onRetry(m)}><RotateCw size={12} /> {t('retry')}</button>}
        </div>
      )}
      <ReactionBadge m={m} />
      {canAct && !m.deleted_at && (
        <div className="bubble-actions">
          {caps?.reply && m.external_id && <button type="button" className="reaction-trigger" title={t('reply')} onClick={() => onReply(m)}><CornerUpLeft size={15} /></button>}
          {reactions && m.external_id && m.status !== 'failed' && <ReactionPicker current={m.reaction_out} options={reactions} onPick={(e) => onReact(m, e)} />}
        </div>
      )}
    </div>
  );
}

export default memo(MessageBubble);
