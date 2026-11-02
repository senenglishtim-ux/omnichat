CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('admin', 'agent')),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per connected account (a WhatsApp number, an Instagram account,
-- a Telegram bot...). Secret config values are stored encrypted (lib/crypto.js).
CREATE TABLE channels (
  id            SERIAL PRIMARY KEY,
  type          TEXT NOT NULL CHECK (type IN ('whatsapp_cloud', 'whatsapp_web', 'instagram', 'telegram')),
  name          TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'new',
  status_detail TEXT,
  account_id    TEXT,            -- phone_number_id / own JID / IG account id / bot id
  account_label TEXT,            -- what to show: +7 700..., @username
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channels_account_idx ON channels (type, account_id);

CREATE TABLE contacts (
  id            SERIAL PRIMARY KEY,
  name          TEXT,
  phone         TEXT,            -- E.164 digits with leading +
  username      TEXT,
  avatar_path   TEXT,
  avatar_checked_at TIMESTAMPTZ,
  -- Free link to the host project's own entity (deal id, customer id...).
  external_ref  TEXT,
  custom        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX contacts_phone_idx ON contacts (phone);
CREATE INDEX contacts_ref_idx ON contacts (external_ref);

CREATE TABLE conversations (
  id               SERIAL PRIMARY KEY,
  channel_id       INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  contact_id       INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  external_id      TEXT NOT NULL,          -- wa_id / chat JID / IGSID / TG chat id
  meta             JSONB NOT NULL DEFAULT '{}',
  assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  unread_count     INTEGER NOT NULL DEFAULT 0,
  last_inbound_at  TIMESTAMPTZ,
  last_outbound_at TIMESTAMPTZ,
  last_message_at  TIMESTAMPTZ,
  last_message_id  BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_id)
);
CREATE INDEX conversations_last_idx ON conversations (last_message_at DESC NULLS LAST);
CREATE INDEX conversations_contact_idx ON conversations (contact_id);

CREATE TABLE messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out', 'note')),
  external_id      TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'played', 'failed', 'received')),
  -- text, image, video, audio, voice, document, sticker, location, contact,
  -- template, interactive, unsupported, note, system
  type             TEXT NOT NULL DEFAULT 'text',
  text             TEXT,
  media_path       TEXT,
  media_mime       TEXT,
  media_name       TEXT,
  media_size       BIGINT,
  media_status     TEXT CHECK (media_status IN ('pending', 'ready', 'failed')),
  media_error      TEXT,
  payload          JSONB,          -- location / contacts / template / buttons / story...
  reply_to_id      BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  reply_to_external TEXT,
  reaction_in      TEXT,           -- the contact's reaction on this message
  reaction_out     TEXT,           -- ours
  sender_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_label     TEXT,           -- "API", "phone", "Instagram app"...
  client_ref       TEXT,           -- client-side temp id, for optimistic UI
  error            TEXT,
  raw              JSONB,
  edited_at        TIMESTAMPTZ,
  deleted_at       TIMESTAMPTZ,
  sent_at          TIMESTAMPTZ,    -- timestamp reported by the channel
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_external_uq ON messages (conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX messages_external_idx ON messages (external_id);
CREATE INDEX messages_conv_idx ON messages (conversation_id, id DESC);
CREATE INDEX messages_text_idx ON messages USING gin (to_tsvector('simple', coalesce(text, '')));

-- WhatsApp Cloud API message templates, per channel (templates belong to a WABA).
CREATE TABLE templates (
  id          SERIAL PRIMARY KEY,
  channel_id  INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id TEXT,
  name        TEXT NOT NULL,
  language    TEXT NOT NULL,
  category    TEXT,
  status      TEXT,
  components  JSONB NOT NULL DEFAULT '[]',
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, name, language)
);

CREATE TABLE api_keys (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  key_prefix   TEXT NOT NULL,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_used_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outgoing webhooks to the host project.
CREATE TABLE webhooks (
  id          SERIAL PRIMARY KEY,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT[] NOT NULL DEFAULT ARRAY['*'],
  is_active   BOOLEAN NOT NULL DEFAULT true,
  last_status INTEGER,
  last_error  TEXT,
  last_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
