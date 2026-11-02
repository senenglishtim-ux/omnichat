// Fill a WhatsApp template's variables ({{1}}, header, URL buttons) with a live preview.
import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { templatePreview, prettify } from './chatShared';

const nums = (s) => [...new Set([...String(s || '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

export default function TemplateModal({ tpl, contactName, busy, onClose, onSend }) {
  const pv = useMemo(() => templatePreview(tpl.components), [tpl]);
  const bodyVars = nums(pv.body);
  const headerVar = pv.headerFormat === 'TEXT' && nums(pv.header).length > 0;
  const headerMedia = ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(pv.headerFormat);
  const urlButtons = pv.buttons.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'URL' && nums(b.url).length);
  const [params, setParams] = useState(() => (bodyVars.includes(1) && contactName ? { 1: contactName } : {}));
  const set = (k, v) => setParams((p) => ({ ...p, [k]: v }));
  const fill = (s, header) => String(s || '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => (header ? params.h1 : params[n]) || `{{${n}}}`);
  const nothingToFill = !bodyVars.length && !headerVar && !headerMedia && !urlButtons.length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>{prettify(tpl.name)}</b><span className="muted"> · {tpl.language}</span><button type="button" className="icon-btn" onClick={onClose}><X size={18} /></button></div>
        {!nothingToFill && <div className="modal-sub">{t('fill_template')}</div>}
        {headerVar && <label className="field">{t('header_var')}<input value={params.h1 || ''} onChange={(e) => set('h1', e.target.value)} /></label>}
        {headerMedia && <label className="field">{t('header_url')}<input value={params.header_url || ''} placeholder="https://" onChange={(e) => set('header_url', e.target.value)} /></label>}
        {bodyVars.map((n) => <label key={n} className="field">{t('variable', { n })}<input value={params[n] || ''} onChange={(e) => set(n, e.target.value)} /></label>)}
        {urlButtons.map(({ b, i }) => <label key={i} className="field">{t('button_var', { b: b.text })}<input value={params[`btn${i}`] || ''} onChange={(e) => set(`btn${i}`, e.target.value)} /></label>)}
        <div className="tpl-preview">
          <div className="muted small">{t('preview')}</div>
          <div className="chat-bubble out static">
            {pv.header && <div className="tpl-h">{headerVar ? fill(pv.header, true) : pv.header}</div>}
            <div className="chat-text">{fill(pv.body)}</div>
            {pv.footer && <div className="tpl-f">{pv.footer}</div>}
            {pv.buttons.length > 0 && <div className="tpl-btns">{pv.buttons.map((b, i) => <span key={i}>{b.text}</span>)}</div>}
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t('cancel')}</button>
          <button type="button" className="primary" disabled={busy || bodyVars.some((n) => !String(params[n] || '').trim())} onClick={() => onSend(params)}>{t('send')}</button>
        </div>
      </div>
    </div>
  );
}
