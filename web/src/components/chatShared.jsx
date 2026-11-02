// Small building blocks of the chat: avatar, channel pin, ticks, reactions,
// template picker, date helpers, linkified text.
import { useEffect, useRef, useState } from 'react';
import { Smile, LayoutList } from 'lucide-react';
import { t, locale } from '../i18n';
import { fileUrl } from '../api';

const AVATAR_COLORS = ['#1E6E5A', '#A3672E', '#2E5FA3', '#8A3EA3', '#A32E5A', '#3E8A6E'];
export function Avatar({ name, phone, url, channel, size }) {
  const label = (name || phone || '?').trim();
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const style = size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : undefined;
  return (
    <div className="avatar" style={style}>
      {url
        ? <img src={fileUrl(url)} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        : null}
      <span className="avatar-initial" style={{ background: AVATAR_COLORS[hash % AVATAR_COLORS.length] }}>{label.replace(/^[@+]/, '').charAt(0).toUpperCase()}</span>
      {channel && <i className={`avatar-chan chan-dot-${CHANNELS[channel]?.cls}`} />}
    </div>
  );
}

export const CHANNELS = {
  whatsapp_cloud: { label: 'WhatsApp', cls: 'wa' },
  whatsapp_web: { label: 'WhatsApp', cls: 'wa' },
  instagram: { label: 'Instagram', cls: 'ig' },
  telegram: { label: 'Telegram', cls: 'tg' },
};
export function ChannelPin({ type, extra }) {
  const c = CHANNELS[type] || { label: type, cls: 'x' };
  return <span className={`chan-pin chan-${c.cls}`} title={extra ? `${c.label} · ${extra}` : c.label}><i />{c.label}{extra ? <em> · {extra}</em> : null}</span>;
}

export function fmtHM(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
export function fmtDayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return t('today');
  if (dayKey(d) === dayKey(new Date(now.getTime() - 864e5))) return t('yesterday');
  const opts = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(locale(), opts);
}
export function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (dayKey(d) === dayKey(new Date())) return fmtHM(d);
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}
export function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export function fmtSeconds(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// URLs become links; everything else stays text (no HTML injection).
const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;
export function Linkify({ text }) {
  if (!text) return null;
  const parts = String(text).split(URL_RE);
  return parts.map((p, i) => (i % 2 ? <a key={i} href={p} target="_blank" rel="noreferrer noopener">{p}</a> : p));
}

// WhatsApp-style ticks: one grey = sent, two grey = delivered, two blue = read/played.
export function Ticks({ status, error }) {
  if (!status || status === 'received') return null;
  if (status === 'pending') return <span className="spinner" title={t('sending')} />;
  if (status === 'failed') return <span className="tick-failed" title={error || t('failed_delivery')}>⚠</span>;
  const double = status !== 'sent';
  return (
    <svg width="16" height="11" viewBox="0 0 16 11" className={`ticks${status === 'read' || status === 'played' ? ' read' : ''}`}
      fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <title>{status}</title>
      {double && <path d="M1 6L4.5 9.5L10 2" />}
      <path d={double ? 'M6 6L9.5 9.5L15 2' : 'M1 6L4.5 9.5L10 2'} />
    </svg>
  );
}

// One reaction per side (contact / us), hanging off the bubble's bottom edge.
export function ReactionBadge({ m }) {
  const list = [m.reaction_in, m.reaction_out].filter(Boolean);
  if (!list.length) return null;
  return (
    <div className="chat-reactions">
      {list[0] === list[1] ? <>{list[0]}<span className="chat-reactions-count">2</span></> : list.join('')}
    </div>
  );
}

export const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '👌', '🔥'];

export function ReactionPicker({ current, options, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, open, () => setOpen(false));
  return (
    <div className={`reaction-picker${open ? ' open' : ''}`} ref={ref}>
      <button type="button" className="reaction-trigger" title={t('react')} onClick={() => setOpen((o) => !o)}><Smile size={16} /></button>
      {open && (
        <div className="reaction-popover">
          {options.map((e) => (
            <button key={e} type="button" className={e === current ? 'active' : ''} title={e === current ? t('remove_reaction') : undefined}
              onClick={() => { setOpen(false); onPick(e === current ? '' : e); }}>{e}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useOutside(ref, active, fn) {
  useEffect(() => {
    if (!active) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) fn(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [active]);
}

export function templatePreview(components) {
  const list = Array.isArray(components) ? components : [];
  const header = list.find((c) => c.type === 'HEADER');
  const body = list.find((c) => c.type === 'BODY');
  const footer = list.find((c) => c.type === 'FOOTER');
  const buttons = list.find((c) => c.type === 'BUTTONS');
  return {
    header: header?.format === 'TEXT' ? header.text : header?.format ? `[${header.format.toLowerCase()}]` : null,
    headerFormat: header?.format || null,
    body: body?.text || '',
    footer: footer?.text || null,
    buttons: buttons?.buttons || [],
  };
}
export const prettify = (name) => name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function TemplatesMenu({ templates, onPick, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, open, () => setOpen(false));
  return (
    <div className="templates-menu" ref={ref}>
      <button type="button" className="icon-btn" title={t('templates_menu')} disabled={disabled} onClick={() => setOpen((o) => !o)}><LayoutList size={18} /></button>
      {open && (
        <div className="templates-popover">
          <div className="templates-popover-head">{t('templates_menu')}</div>
          {templates.length ? templates.map((tp) => (
            <button key={tp.id} type="button" className="template-option" onClick={() => { setOpen(false); onPick(tp); }}>
              <div className="template-option-title">{prettify(tp.name)} <span className="muted">· {tp.language}</span></div>
              <div className="template-option-body">{templatePreview(tp.components).body || tp.name}</div>
            </button>
          )) : <div className="templates-popover-empty">{t('no_templates')}</div>}
        </div>
      )}
    </div>
  );
}
