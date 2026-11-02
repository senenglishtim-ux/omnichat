// Messenger-style audio / video players (ported from the original CRM). Audio looks
// like a voice note: round play button, a waveform you can click/drag to
// seek, time and a speed toggle. The waveform is decoded from the actual file
// (same-origin or blob URLs); otherwise a stable pseudo-waveform is drawn.
// Only one player plays at a time across the page.
import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Volume2, VolumeX, Maximize2, Download, Loader2 } from 'lucide-react';
import { t } from '../i18n';

const BARS = 44;
const SPEEDS = [1, 1.5, 2];

let current = null;
function claim(el) {
  if (current && current !== el && !current.paused) current.pause();
  current = el;
}

export function fmtClock(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function pseudoPeaks(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  const out = [];
  for (let i = 0; i < BARS; i++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    const wave = 0.55 + 0.35 * Math.sin(i / 3.1) * Math.cos(i / 7.3);
    out.push(Math.max(0.12, Math.min(1, wave * (0.55 + (h % 1000) / 1000 * 0.6))));
  }
  return out;
}

// Real peaks from the file; resolves null when the browser can't decode it.
const peakCache = new Map();
async function decodePeaks(url) {
  if (peakCache.has(url)) return peakCache.get(url);
  const p = (async () => {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      const ctx = new Ctx();
      const audio = await ctx.decodeAudioData(buf);
      ctx.close?.();
      const data = audio.getChannelData(0);
      const step = Math.floor(data.length / BARS) || 1;
      const peaks = [];
      for (let i = 0; i < BARS; i++) {
        let max = 0;
        for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) max = Math.max(max, Math.abs(data[j]));
        peaks.push(max);
      }
      const top = Math.max(...peaks) || 1;
      return { peaks: peaks.map((v) => Math.max(0.1, v / top)), duration: audio.duration };
    } catch { return null; }
  })();
  peakCache.set(url, p);
  return p;
}

export function AudioPlayer({ src, tone = 'default', download, preload = 'metadata', autoPlay }) {
  const ref = useRef(null);
  const waveRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [peaks, setPeaks] = useState(() => pseudoPeaks(src || ''));

  useEffect(() => {
    let alive = true;
    setPeaks(pseudoPeaks(src || ''));
    if (src && (src.startsWith('blob:') || src.startsWith('/'))) {
      decodePeaks(src).then((r) => {
        if (!alive || !r) return;
        setPeaks(r.peaks);
        if (Number.isFinite(r.duration)) setDuration((d) => (Number.isFinite(d) && d > 0 ? d : r.duration));
      });
    }
    return () => { alive = false; };
  }, [src]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const onMeta = () => {
      // MediaRecorder webm/ogg often reports Infinity until fully scanned
      if (a.duration === Infinity) {
        const fix = () => { a.removeEventListener('timeupdate', fix); setDuration(a.duration); a.currentTime = 0; };
        a.addEventListener('timeupdate', fix);
        a.currentTime = 1e7;
      } else if (Number.isFinite(a.duration)) setDuration(a.duration);
    };
    const onTime = () => setTime(a.currentTime);
    const onPlay = () => { setPlaying(true); setLoading(false); };
    const onPause = () => setPlaying(false);
    const onEnd = () => { setPlaying(false); setTime(0); a.currentTime = 0; };
    const onWait = () => setLoading(true);
    const onCan = () => setLoading(false);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onEnd);
    a.addEventListener('waiting', onWait);
    a.addEventListener('canplay', onCan);
    return () => {
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('waiting', onWait);
      a.removeEventListener('canplay', onCan);
    };
  }, [src]);

  useEffect(() => {
    if (autoPlay && ref.current) { claim(ref.current); ref.current.play().catch(() => {}); }
  }, [src, autoPlay]);

  function toggle() {
    const a = ref.current;
    if (!a) return;
    if (a.paused) { claim(a); setLoading(a.readyState < 3); a.play().catch(() => setLoading(false)); } else a.pause();
  }
  function cycleSpeed() {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (ref.current) ref.current.playbackRate = next;
  }
  function seekAt(clientX) {
    const el = waveRef.current;
    const a = ref.current;
    if (!el || !a || !duration) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    a.currentTime = frac * duration;
    setTime(a.currentTime);
  }
  function onPointerDown(e) {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekAt(e.clientX);
    const move = (ev) => seekAt(ev.clientX);
    const up = () => { e.currentTarget.removeEventListener('pointermove', move); e.currentTarget.removeEventListener('pointerup', up); };
    e.currentTarget.addEventListener('pointermove', move);
    e.currentTarget.addEventListener('pointerup', up);
  }
  function onKey(e) {
    const a = ref.current;
    if (!a || !duration) return;
    if (e.key === 'ArrowRight') { a.currentTime = Math.min(duration, a.currentTime + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { a.currentTime = Math.max(0, a.currentTime - 5); e.preventDefault(); }
  }

  const progress = duration ? time / duration : 0;
  return (
    <div className={`ap ap-${tone}${playing ? ' playing' : ''}`}>
      <audio ref={ref} src={src} preload={preload} />
      <button type="button" className="ap-btn" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
        {loading ? <Loader2 size={16} className="ap-spin" /> : playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ap-play-icon" />}
      </button>
      <div className="ap-main">
        <div className="ap-wave" ref={waveRef} onPointerDown={onPointerDown} onKeyDown={onKey}
          role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}>
          {peaks.map((v, i) => (
            <span key={i} className={(i + 0.5) / peaks.length <= progress ? 'on' : ''} style={{ height: `${Math.round(v * 100)}%` }} />
          ))}
        </div>
        <div className="ap-foot">
          <span className="ap-time">{playing || time > 0 ? fmtClock(time) : fmtClock(duration)}</span>
          <span className="ap-tools">
            <button type="button" className="ap-speed" onClick={cycleSpeed} title="Speed">{speed}×</button>
            {download && <a className="ap-dl" href={download === true ? src : download} download title={t('download')}><Download size={13} /></a>}
          </span>
        </div>
      </div>
    </div>
  );
}

// Video player with a custom control bar: seek with hover time, speed,
// mute, fullscreen, keyboard (space/K, ←/→, J/L, F, M, 0-9).
const VSPEEDS = [1, 1.25, 1.5, 2];

export function VideoPlayer({ src, preload = 'metadata', className = '', round, gif }) {
  const wrapRef = useRef(null);
  const ref = useRef(null);
  const barRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(!!gif);
  const [loading, setLoading] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [hover, setHover] = useState(null);
  const [scrub, setScrub] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const updBuf = () => {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime + 0.5 && b.end(i) >= v.currentTime) { setBuffered(b.end(i)); return; }
      setBuffered(v.currentTime);
    };
    const h = {
      loadedmetadata: () => Number.isFinite(v.duration) && setDuration(v.duration),
      durationchange: () => Number.isFinite(v.duration) && setDuration(v.duration),
      timeupdate: () => { setTime(v.currentTime); updBuf(); },
      progress: updBuf,
      play: () => { setPlaying(true); setStarted(true); },
      pause: () => setPlaying(false),
      playing: () => setLoading(false),
      ended: () => setPlaying(false),
      waiting: () => setLoading(true),
      error: () => { setLoading(false); setPlaying(false); setFailed(true); },
      seeking: () => setLoading(true),
      seeked: () => setLoading(false),
      canplay: () => setLoading(false),
    };
    Object.entries(h).forEach(([k, f]) => v.addEventListener(k, f));
    return () => Object.entries(h).forEach(([k, f]) => v.removeEventListener(k, f));
  }, [src]);

  function play() {
    const v = ref.current;
    setStarted(true); setFailed(false);
    if (v.readyState < 3) setLoading(true);
    claim(v);
    return v.play().catch((e) => { if (e?.name !== 'AbortError') setLoading(false); });
  }
  function toggle() { const v = ref.current; if (!v) return; if (v.paused) play(); else v.pause(); }
  function seekTo(tm) {
    const v = ref.current; const d = duration || v.duration;
    if (!Number.isFinite(tm) || !d) return;
    const to = Math.min(d - 0.1, Math.max(0, tm)); setTime(to); v.currentTime = to;
  }
  const timeAt = (clientX) => {
    const r = barRef.current.getBoundingClientRect();
    return { x: Math.min(r.width, Math.max(0, clientX - r.left)), t: Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration };
  };
  function onBarDown(e) {
    e.stopPropagation();
    if (!duration) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const first = timeAt(e.clientX); setScrub(first.t); setHover(first);
    const move = (ev) => { const p = timeAt(ev.clientX); setScrub(p.t); setHover(p); };
    const up = (ev) => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      const p = timeAt(ev.clientX); setScrub(null); if (ev.pointerType !== 'mouse') setHover(null); seekTo(p.t);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }
  function onBarHover(e) { if (!duration || scrub != null) return; setHover(timeAt(e.clientX)); }
  function fullscreen(e) {
    e?.stopPropagation();
    const el = wrapRef.current;
    if (document.fullscreenElement) document.exitFullscreen();
    else (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el);
  }
  function cycleSpeed(e) {
    e.stopPropagation();
    const next = VSPEEDS[(VSPEEDS.indexOf(speed) + 1) % VSPEEDS.length];
    setSpeed(next); ref.current.playbackRate = next;
  }
  function onKey(e) {
    if (e.target.closest('input, textarea')) return;
    const v = ref.current; const k = e.key.toLowerCase();
    const jump = (d) => { e.preventDefault(); seekTo(v.currentTime + d); };
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'arrowleft') jump(-5);
    else if (k === 'arrowright') jump(5);
    else if (k === 'j') jump(-10);
    else if (k === 'l') jump(10);
    else if (k === 'f') fullscreen();
    else if (k === 'm') setMuted((m) => !m);
    else if (/^[0-9]$/.test(k) && duration) { e.preventDefault(); seekTo((Number(k) / 10) * duration); }
  }

  const shown = scrub ?? time;
  const barW = barRef.current?.getBoundingClientRect().width || 0;
  const tipLeft = hover ? Math.min(Math.max(0, hover.x - 24), Math.max(0, barW - 48)) : 0;

  return (
    <div ref={wrapRef} tabIndex={0} onKeyDown={onKey} onDoubleClick={fullscreen}
      className={`vp${playing ? ' playing' : ''}${started ? ' started' : ''}${scrub != null ? ' scrubbing' : ''}${round ? ' vp-round' : ''} ${className}`.trim()} onClick={toggle}>
      <video ref={ref} src={src} preload={preload} muted={muted} playsInline loop={!!gif || !!round} autoPlay={!!gif} />
      <div className="vp-center">
        {failed
          ? <button type="button" className="vp-fail" onClick={(e) => { e.stopPropagation(); ref.current.load(); play(); }}>{t('media_failed')} · {t('retry')}</button>
          : loading && started ? <Loader2 size={26} className="ap-spin" /> : !playing && !gif && <span className="vp-big"><Play size={24} fill="currentColor" /></span>}
      </div>
      {!round && !gif && (
        <div className="vp-bar" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="vp-icon" onClick={toggle}>{playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}</button>
          <span className="vp-time">{fmtClock(shown)}</span>
          <div className="vp-track" ref={barRef} onPointerDown={onBarDown} onPointerMove={onBarHover} onPointerLeave={() => scrub == null && setHover(null)}>
            <div className="vp-buf" style={{ width: `${duration ? Math.min(100, (buffered / duration) * 100) : 0}%` }} />
            {hover && duration > 0 && (
              <>
                <div className="vp-hoverfill" style={{ width: `${(hover.t / duration) * 100}%` }} />
                <div className="vp-tip" style={{ left: tipLeft }}><span>{fmtClock(hover.t)}</span></div>
              </>
            )}
            <div className="vp-fill" style={{ width: `${duration ? (shown / duration) * 100 : 0}%` }} />
          </div>
          <span className="vp-time">{fmtClock(duration)}</span>
          <button type="button" className="vp-icon vp-speed" onClick={cycleSpeed}>{speed}×</button>
          <button type="button" className="vp-icon" onClick={() => setMuted((m) => !m)}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button>
          <button type="button" className="vp-icon" onClick={fullscreen}><Maximize2 size={14} /></button>
        </div>
      )}
    </div>
  );
}
