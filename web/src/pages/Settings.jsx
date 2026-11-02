import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Copy, Check, Plus, X, RefreshCw } from 'lucide-react';
import { api, getUser, BASE } from '../api';
import { subscribe } from '../lib/stream';
import { t, getLang, setLang } from '../i18n';
import { CHANNELS, templatePreview, prettify } from '../components/chatShared';

function CopyField({ value }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="copy-field">
      <code>{value}</code>
      <button type="button" className="icon-btn" title={t('copy')} onClick={() => { navigator.clipboard?.writeText(value); setOk(true); setTimeout(() => setOk(false), 1200); }}>
        {ok ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </div>
  );
}

const STATUS_CLS = { connected: 'ok', qr: 'warn', connecting: 'warn', new: 'muted', disabled: 'muted' };
function StatusBadge({ status }) {
  return <span className={`status-badge ${STATUS_CLS[status] || 'bad'}`}>{t(`status_${status}`) === `status_${status}` ? status : t(`status_${status}`)}</span>;
}

// ------------------------------------------------------------------ channels
function ChannelForm({ type, channel, onSaved, onCancel }) {
  const [name, setName] = useState(channel?.name || type.title);
  const [cfg, setCfg] = useState(channel?.config || {});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setErr('');
    try {
      const r = channel ? await api.patch(`/channels/${channel.id}`, { name, config: cfg }) : await api.post('/channels', { type: type.type, name, config: cfg });
      onSaved(r);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <div className="card form-card">
      <label className="field">{t('channel_name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      {type.fields.map((f) => (
        <label key={f.key} className={`field${f.type === 'boolean' ? ' check' : ''}`}>
          {f.type === 'boolean' ? (
            <><input type="checkbox" checked={cfg[f.key] === true || cfg[f.key] === 'true'} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.checked })} /> {f.label}</>
          ) : (
            <>{f.label}{f.required ? ' *' : ''}
              {f.type === 'select'
                ? <select value={cfg[f.key] || ''} onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                : <input type={f.secret ? 'password' : 'text'} value={cfg[f.key] || ''} autoComplete="off" onChange={(e) => setCfg({ ...cfg, [f.key]: e.target.value })} placeholder={f.secret && channel ? '••••' : ''} />}
            </>
          )}
          {f.help && <span className="field-help">{f.help}</span>}
        </label>
      ))}
      {type.type === 'whatsapp_web' && <div className="hint warn">{t('baileys_warning')}</div>}
      {err && <div className="error-text">{err}</div>}
      <div className="row-actions">
        <button type="button" onClick={onCancel}>{t('cancel')}</button>
        <button type="button" className="primary" disabled={busy} onClick={save}>{t('save')}</button>
      </div>
    </div>
  );
}

function ChannelCard({ ch, type, onChange, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [qr, setQr] = useState({ qr: null, pairing_code: null });
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ch.type !== 'whatsapp_web') return undefined;
    api.get(`/channels/${ch.id}/qr`).then(setQr).catch(() => {});
    return subscribe((ev, data) => {
      if (ev === 'channel.updated' && data.channel_id === ch.id) {
        if ('qr' in data) setQr({ qr: data.qr, pairing_code: data.pairing_code || null });
        onChange({ ...ch, ...data, id: ch.id });
      }
    });
  }, [ch.id]);

  async function run(fn) {
    setBusy(true); setMsg('');
    try { const r = await fn(); setMsg(typeof r === 'string' ? r : t('done')); } catch (e) { setMsg(`⚠ ${e.message}`); } finally { setBusy(false); }
  }
  const action = (a) => run(async () => {
    const r = await api.post(`/channels/${ch.id}/actions/${a}`);
    const list = await api.get('/channels'); onChange(list.find((x) => x.id === ch.id));
    return a === 'sync_templates' ? `${t('done')}: ${r.result}` : t('done');
  });

  return (
    <div className="card channel-card">
      <div className="channel-head">
        <span className={`chan-dot-${CHANNELS[ch.type]?.cls} big`} />
        <div className="channel-title">
          <b>{ch.name}</b>
          <span className="muted">{type?.title}{ch.account_label ? ` · ${ch.account_label}` : ''}</span>
        </div>
        <StatusBadge status={ch.is_active ? ch.status : 'disabled'} />
      </div>
      {ch.status_detail && ch.status !== 'connected' && <div className="muted small">{ch.status_detail}</div>}
      {ch.type === 'whatsapp_web' && ch.status === 'qr' && qr.qr && (
        <div className="qr-box">
          <img src={qr.qr} alt="QR" />
          <div>
            <p>{t('scan_qr')}</p>
            {qr.pairing_code && <><p className="muted">{t('pairing_code')}</p><div className="pairing-code">{qr.pairing_code}</div></>}
          </div>
        </div>
      )}
      {ch.webhook_url && (
        <div className="kv">
          <span>{t('webhook_url')}</span><CopyField value={ch.webhook_url} />
          {ch.config?.verify_token && <><span>Verify token</span><CopyField value={ch.config.verify_token} /></>}
        </div>
      )}
      {editing ? (
        <ChannelForm type={type} channel={ch} onCancel={() => setEditing(false)} onSaved={(c) => { setEditing(false); onChange(c); }} />
      ) : (
        <div className="row-actions wrap">
          <button type="button" onClick={() => setEditing(true)}>{t('edit')}</button>
          {ch.type !== 'whatsapp_web' && <button type="button" disabled={busy} onClick={() => run(async () => JSON.stringify((await api.post(`/channels/${ch.id}/test`)).info))}>{t('test')}</button>}
          <button type="button" disabled={busy} onClick={() => run(async () => { onChange(await api.post(`/channels/${ch.id}/restart`)); return t('done'); })}><RefreshCw size={14} /> {t('restart')}</button>
          {(type?.actions || []).filter((a) => a !== 'reconnect').map((a) => <button key={a} type="button" disabled={busy} onClick={() => action(a)}>{t(`action_${a}`)}</button>)}
          <button type="button" onClick={() => run(async () => { onChange(await api.patch(`/channels/${ch.id}`, { is_active: !ch.is_active })); return t('saved'); })}>{ch.is_active ? t('disable') : t('enable')}</button>
          <button type="button" className="danger" onClick={() => { if (window.confirm(t('confirm_delete'))) api.del(`/channels/${ch.id}`).then(onDelete); }}>{t('delete')}</button>
        </div>
      )}
      {msg && <div className="muted small break">{msg}</div>}
    </div>
  );
}

function Channels() {
  const [types, setTypes] = useState([]);
  const [list, setList] = useState([]);
  const [adding, setAdding] = useState(null);
  useEffect(() => { api.get('/channels/types').then(setTypes); api.get('/channels').then(setList); }, []);
  const typeOf = (k) => types.find((x) => x.type === k);
  return (
    <div>
      <h2>{t('channels')}</h2>
      {!adding && (
        <div className="type-grid">
          {types.map((ty) => (
            <button key={ty.type} type="button" className="type-tile" onClick={() => setAdding(ty)}>
              <span className={`chan-dot-${CHANNELS[ty.type]?.cls} big`} /><b>{ty.title}</b><Plus size={16} />
            </button>
          ))}
        </div>
      )}
      {adding && <><h3>{t('add_channel')}: {adding.title}</h3><ChannelForm type={adding} onCancel={() => setAdding(null)} onSaved={(c) => { setAdding(null); setList((l) => [...l, c]); }} /></>}
      <div className="cards">
        {list.map((ch) => <ChannelCard key={ch.id} ch={ch} type={typeOf(ch.type)}
          onChange={(c) => c && setList((l) => l.map((x) => (x.id === c.id ? { ...x, ...c } : x)))}
          onDelete={() => setList((l) => l.filter((x) => x.id !== ch.id))} />)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ team
function Team() {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/users').then(setUsers);
  useEffect(() => { load(); }, []);
  async function save() {
    setErr('');
    try {
      if (form.id) await api.patch(`/users/${form.id}`, { name: form.name, email: form.email, role: form.role, ...(form.password ? { password: form.password } : {}) });
      else await api.post('/users', form);
      setForm(null); load();
    } catch (e) { setErr(e.message); }
  }
  return (
    <div>
      <h2>{t('users')}</h2>
      <table className="table">
        <thead><tr><th>{t('name')}</th><th>{t('email')}</th><th>{t('role')}</th><th /></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.is_active ? '' : 'inactive'}>
              <td>{u.name}</td><td>{u.email}</td><td>{t(u.role)}</td>
              <td className="right">
                <button type="button" onClick={() => setForm({ ...u, password: '' })}>{t('edit')}</button>{' '}
                {u.id !== getUser()?.id && <button type="button" onClick={() => api.patch(`/users/${u.id}`, { is_active: !u.is_active }).then(load)}>{u.is_active ? t('disable') : t('enable')}</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {form ? (
        <div className="card form-card">
          <label className="field">{t('name')}<input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="field">{t('email')}<input value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="field">{form.id ? t('new_password') : t('password')}<input type="password" value={form.password || ''} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label className="field">{t('role')}<select value={form.role || 'agent'} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="agent">{t('agent')}</option><option value="admin">{t('admin')}</option></select></label>
          {err && <div className="error-text">{err}</div>}
          <div className="row-actions"><button type="button" onClick={() => setForm(null)}>{t('cancel')}</button><button type="button" className="primary" onClick={save}>{t('save')}</button></div>
        </div>
      ) : <button type="button" className="primary" onClick={() => setForm({ role: 'agent' })}><Plus size={15} /> {t('invite')}</button>}
    </div>
  );
}

// ------------------------------------------------------------------ templates
function Templates() {
  const [channels, setChannels] = useState([]);
  const [cid, setCid] = useState('');
  const [list, setList] = useState([]);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/channels').then((l) => { const wa = l.filter((c) => c.type === 'whatsapp_cloud'); setChannels(wa); if (wa[0]) setCid(String(wa[0].id)); }); }, []);
  const load = () => cid && api.get(`/templates?channel_id=${cid}`).then(setList);
  useEffect(() => { load(); }, [cid]);
  async function sync() { setMsg(''); try { const r = await api.post(`/channels/${cid}/actions/sync_templates`); setMsg(`${t('done')}: ${r.result}`); load(); } catch (e) { setMsg(`⚠ ${e.message}`); } }
  async function create() {
    setMsg('');
    try { await api.post('/templates', { ...form, channel_id: Number(cid) }); setForm(null); load(); } catch (e) { setMsg(`⚠ ${e.message}`); }
  }
  if (!channels.length) return <div><h2>{t('templates')}</h2><p className="muted">WhatsApp Cloud API —</p></div>;
  return (
    <div>
      <h2>{t('templates')}</h2>
      <div className="row-actions">
        <select value={cid} onChange={(e) => setCid(e.target.value)} style={{ width: 'auto' }}>{channels.map((c) => <option key={c.id} value={c.id}>{c.name} {c.account_label || ''}</option>)}</select>
        <button type="button" onClick={sync}><RefreshCw size={14} /> {t('action_sync_templates')}</button>
        <button type="button" className="primary" onClick={() => setForm({ language: getLang() === 'ru' ? 'ru' : 'en', category: 'UTILITY', buttons: [] })}><Plus size={15} /> {t('create_template')}</button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      {form && (
        <div className="card form-card">
          <label className="field">name (a-z, 0-9, _)<input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} /></label>
          <div className="grid2">
            <label className="field">{t('language')}<input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} /></label>
            <label className="field">{t('category')}<select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option>UTILITY</option><option>MARKETING</option><option>AUTHENTICATION</option></select></label>
          </div>
          <label className="field">{t('header')}<input value={form.header_text || ''} onChange={(e) => setForm({ ...form, header_text: e.target.value })} /></label>
          <label className="field">{t('body')} — {'{{1}}, {{2}}'}<textarea rows={4} value={form.body_text || ''} onChange={(e) => setForm({ ...form, body_text: e.target.value })} /></label>
          <label className="field">{t('footer')}<input value={form.footer_text || ''} onChange={(e) => setForm({ ...form, footer_text: e.target.value })} /></label>
          <div className="field">{t('buttons')}
            {form.buttons.map((b, i) => (
              <div key={i} className="btn-row">
                <select value={b.type} onChange={(e) => setForm({ ...form, buttons: form.buttons.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)) })}><option>QUICK_REPLY</option><option>URL</option><option>PHONE_NUMBER</option></select>
                <input placeholder="text" value={b.text} onChange={(e) => setForm({ ...form, buttons: form.buttons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} />
                {b.type === 'URL' && <input placeholder="https://" value={b.url || ''} onChange={(e) => setForm({ ...form, buttons: form.buttons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />}
                {b.type === 'PHONE_NUMBER' && <input placeholder="+7..." value={b.phone_number || ''} onChange={(e) => setForm({ ...form, buttons: form.buttons.map((x, j) => (j === i ? { ...x, phone_number: e.target.value } : x)) })} />}
                <button type="button" className="icon-btn" onClick={() => setForm({ ...form, buttons: form.buttons.filter((_, j) => j !== i) })}><X size={15} /></button>
              </div>
            ))}
            {form.buttons.length < 3 && <button type="button" onClick={() => setForm({ ...form, buttons: [...form.buttons, { type: 'QUICK_REPLY', text: '' }] })}><Plus size={14} /></button>}
          </div>
          <div className="row-actions"><button type="button" onClick={() => setForm(null)}>{t('cancel')}</button><button type="button" className="primary" onClick={create}>{t('submit_review')}</button></div>
        </div>
      )}
      <div className="cards">
        {list.map((tp) => {
          const pv = templatePreview(tp.components);
          return (
            <div key={tp.id} className="card tpl-card">
              <div className="channel-head"><b>{prettify(tp.name)}</b><span className="muted">{tp.name} · {tp.language} · {tp.category}</span>
                <span className={`status-badge ${tp.status === 'APPROVED' ? 'ok' : tp.status === 'REJECTED' ? 'bad' : 'warn'}`}>{tp.status}</span></div>
              <div className="chat-bubble out static">
                {pv.header && <div className="tpl-h">{pv.header}</div>}
                <div className="chat-text">{pv.body}</div>
                {pv.footer && <div className="tpl-f">{pv.footer}</div>}
                {pv.buttons.length > 0 && <div className="tpl-btns">{pv.buttons.map((b, i) => <span key={i}>{b.text}</span>)}</div>}
              </div>
              <div className="row-actions"><button type="button" className="danger" onClick={() => { if (window.confirm(t('confirm_delete'))) api.del(`/templates/${cid}/${tp.name}`).then(load).catch((e) => setMsg(e.message)); }}>{t('delete')}</button></div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ API & webhooks
const EVENTS = ['message.created', 'message.updated', 'conversation.updated', 'channel.updated'];
function ApiPage() {
  const [keys, setKeys] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [newKey, setNewKey] = useState(null);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => { api.get('/admin/api-keys').then(setKeys); api.get('/admin/webhooks').then(setHooks); };
  useEffect(() => { load(); }, []);
  const origin = `${window.location.origin}${BASE}`;
  return (
    <div>
      <h2>{t('api_keys')}</h2>
      {newKey && <div className="hint ok">{t('key_once')}<CopyField value={newKey} /></div>}
      <table className="table">
        <tbody>{keys.map((k) => <tr key={k.id}><td>{k.name}</td><td><code>{k.key_prefix}…</code></td><td className="muted small">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}</td>
          <td className="right"><button type="button" className="danger" onClick={() => api.del(`/admin/api-keys/${k.id}`).then(load)}>{t('delete')}</button></td></tr>)}</tbody>
      </table>
      <button type="button" className="primary" onClick={async () => { const name = window.prompt(t('name'), 'My CRM'); if (!name) return; const r = await api.post('/admin/api-keys', { name }); setNewKey(r.key); load(); }}><Plus size={15} /> {t('new_key')}</button>

      <h2>{t('webhooks')}</h2>
      <table className="table">
        <tbody>{hooks.map((w) => (
          <tr key={w.id} className={w.is_active ? '' : 'inactive'}>
            <td className="break">{w.url}<div className="muted small">{w.events.join(', ')}</div></td>
            <td><span className="muted small">{t('secret')}</span><CopyField value={w.secret} /></td>
            <td className="small">{w.last_status ? `HTTP ${w.last_status}` : ''} {w.last_error || ''}</td>
            <td className="right nowrap">
              <button type="button" onClick={() => api.post(`/admin/webhooks/${w.id}/test`).then((r) => setMsg(`ping → ${r.status || r.error}`)).then(load)}>{t('test')}</button>{' '}
              <button type="button" onClick={() => api.patch(`/admin/webhooks/${w.id}`, { is_active: !w.is_active }).then(load)}>{w.is_active ? t('disable') : t('enable')}</button>{' '}
              <button type="button" className="danger" onClick={() => api.del(`/admin/webhooks/${w.id}`).then(load)}>{t('delete')}</button>
            </td>
          </tr>
        ))}</tbody>
      </table>
      <div className="row-actions">
        <input placeholder="https://your-app.example.com/omnichat-webhook" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button type="button" className="primary" onClick={() => api.post('/admin/webhooks', { url }).then(() => { setUrl(''); load(); }).catch((e) => setMsg(e.message))}>{t('add_webhook')}</button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
      <p className="muted small">{t('events')}: {EVENTS.join(', ')}. Header <code>X-Omnichat-Signature: sha256=HMAC(secret, body)</code></p>

      <h2>Quick start</h2>
      <pre className="code">{`# send a message
curl -X POST ${origin}/api/conversations/start -H "X-Api-Key: ock_..." \\
  -H "Content-Type: application/json" -d '{"channel_id":1,"phone":"+77001234567","external_ref":"deal-42"}'
curl -X POST ${origin}/api/conversations/<id>/messages -H "X-Api-Key: ock_..." \\
  -H "Content-Type: application/json" -d '{"text":"Hello!"}'

# embed the chat of a contact into your app (iframe)
curl -X POST ${origin}/api/embed/token -H "X-Api-Key: ock_..." \\
  -H "Content-Type: application/json" -d '{"external_ref":"deal-42"}'
# -> { "url": "${origin}/embed/12?token=..." }  →  <iframe src="...">`}</pre>
      <p className="muted small">{t('docs_hint')}</p>
    </div>
  );
}

function Profile() {
  const me = getUser();
  const [pw, setPw] = useState('');
  const [msg, setMsg] = useState('');
  return (
    <div>
      <h2>{t('profile')}</h2>
      <div className="card form-card">
        <div><b>{me?.name}</b> <span className="muted">{me?.email}</span></div>
        <label className="field">{t('new_password')}<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <div className="row-actions"><button type="button" className="primary" disabled={pw.length < 8} onClick={() => api.patch(`/users/${me.id}`, { password: pw }).then(() => { setPw(''); setMsg(t('saved')); }).catch((e) => setMsg(e.message))}>{t('save')}</button></div>
        {msg && <div className="muted small">{msg}</div>}
        <div className="lang-switch left">
          <button type="button" className={getLang() === 'ru' ? 'on' : ''} onClick={() => setLang('ru')}>Русский</button>
          <button type="button" className={getLang() === 'en' ? 'on' : ''} onClick={() => setLang('en')}>English</button>
        </div>
      </div>
    </div>
  );
}

export default function Settings() {
  const admin = getUser()?.role === 'admin';
  const links = admin ? [['channels', t('channels')], ['team', t('users')], ['templates', t('templates')], ['api', t('api')], ['profile', t('profile')]] : [['profile', t('profile')]];
  return (
    <div className="settings">
      <nav className="settings-nav">{links.map(([k, l]) => <NavLink key={k} to={`/settings/${k}`}>{l}</NavLink>)}</nav>
      <div className="settings-body">
        <Routes>
          {admin && <Route path="channels" element={<Channels />} />}
          {admin && <Route path="team" element={<Team />} />}
          {admin && <Route path="templates" element={<Templates />} />}
          {admin && <Route path="api" element={<ApiPage />} />}
          <Route path="profile" element={<Profile />} />
          <Route path="*" element={<Navigate to={admin ? 'channels' : 'profile'} replace />} />
        </Routes>
      </div>
    </div>
  );
}
