// /embed/:contactId?token=... - just the chat, for an <iframe> in the host app.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, setEmbedToken } from '../api';
import ChatView from '../components/ChatView';

const token = new URLSearchParams(window.location.search).get('token');
if (token) setEmbedToken(token);

export default function Embed() {
  const { contactId } = useParams();
  const [convId, setConvId] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!token) { setErr('Missing token'); return; }
    api.get(`/conversations?contact_id=${contactId}&limit=1`)
      .then((r) => (r.items[0] ? setConvId(r.items[0].id) : setErr('No conversations for this contact yet')))
      .catch((e) => setErr(e.message));
  }, [contactId]);
  return <div className="embed-root">{convId ? <ChatView conversationId={convId} embedded /> : <div className="chat-loading">{err || <span className="spinner dark" />}</div>}</div>;
}
