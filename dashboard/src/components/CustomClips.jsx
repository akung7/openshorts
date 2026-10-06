import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Clapperboard, FileText, Loader2, MessageCircle, Play, UploadCloud } from 'lucide-react';
import { apiFetch, apiJson } from '../lib/api';
import { getApiUrl } from '../config';

async function sendForm(path, form) {
  const response = await apiFetch(path, { method: 'POST', body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return payload;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function CustomClips() {
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [guideMode, setGuideMode] = useState('text');
  const [guideFile, setGuideFile] = useState(null);
  const [guideUrl, setGuideUrl] = useState('');
  const [guideText, setGuideText] = useState('');
  const [rightsAcknowledged, setRightsAcknowledged] = useState(false);
  const [draft, setDraft] = useState(null);
  const [selected, setSelected] = useState([]);
  const [chatMessage, setChatMessage] = useState('');
  const [busyChat, setBusyChat] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [renderedClips, setRenderedClips] = useState([]);

  const isBusy = Boolean(activeJob);
  const eligibleGuideline = useMemo(() => {
    if (guideMode === 'file') return Boolean(guideFile);
    if (guideMode === 'url') return Boolean(guideUrl.trim());
    return Boolean(guideText.trim());
  }, [guideFile, guideMode, guideText, guideUrl]);

  useEffect(() => {
    if (!activeJob) return undefined;
    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        while (!cancelled) {
          const snapshot = await apiJson(`/api/status/${encodeURIComponent(activeJob.id)}`);
          if (cancelled) return;
          setStatusText(snapshot.status === 'queued' ? 'Waiting in the processing queue…' : 'Working…');
          if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
            const lines = Array.isArray(snapshot.logs) ? snapshot.logs : [];
            throw new Error(lines.slice(-3).join('\n') || 'The job failed.');
          }
          if (snapshot.status === 'completed') {
            if (activeJob.kind === 'analysis') {
              const nextDraft = await apiJson(`/api/custom/drafts/${encodeURIComponent(activeJob.id)}`);
              if (cancelled) return;
              setDraft(nextDraft);
              setSelected([]);
              setStatusText('Draft ready — review candidates before approving any render.');
            } else {
              const clips = snapshot.result?.clips || [];
              setRenderedClips(clips);
              setStatusText(clips.length ? `${clips.length} approved clip(s) rendered.` : 'Render completed, but no clips were returned.');
            }
            setActiveJob(null);
            return;
          }
          await wait(1800);
        }
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError?.message || 'Could not check job status.');
          setStatusText('');
          setActiveJob(null);
        }
      }
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [activeJob]);

  const startAnalysis = async (event) => {
    event.preventDefault();
    setError('');
    setStatusText('Preparing campaign analysis…');
    setRenderedClips([]);
    try {
      const form = new FormData();
      if (sourceFile) form.append('file', sourceFile);
      if (sourceUrl.trim()) form.append('url', sourceUrl.trim());
      if (guideMode === 'file' && guideFile) form.append('guideline_file', guideFile);
      if (guideMode === 'url' && guideUrl.trim()) form.append('guideline_url', guideUrl.trim());
      if (guideMode === 'text') form.append('guideline_text', guideText);
      form.append('acknowledged', rightsAcknowledged ? '1' : '0');
      const job = await sendForm('/api/custom/analyze', form);
      setDraft(null);
      setSelected([]);
      setActiveJob({ id: job.draft_id || job.job_id, kind: 'analysis' });
    } catch (requestError) {
      setStatusText('');
      setError(requestError?.message || 'Could not start campaign analysis.');
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!draft || !chatMessage.trim() || busyChat) return;
    setBusyChat(true);
    setError('');
    try {
      const result = await apiJson(`/api/custom/drafts/${encodeURIComponent(draft.id)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: draft.revision, message: chatMessage.trim() }),
      });
      setDraft(result.draft);
      setSelected([]);
      setChatMessage('');
      setStatusText('Draft revised. Please review and select candidates again.');
    } catch (requestError) {
      setError(requestError?.detail || requestError?.message || 'Could not revise the draft.');
    } finally {
      setBusyChat(false);
    }
  };

  const approveAndRender = async () => {
    if (!draft || !selected.length || isBusy) return;
    const confirmed = window.confirm(`Render ${selected.length} selected candidate(s)? Only these approved ranges will be rendered.`);
    if (!confirmed) return;
    setError('');
    setStatusText('Submitting the approved render…');
    try {
      const result = await apiJson(`/api/custom/drafts/${encodeURIComponent(draft.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: draft.revision, selected_clip_ids: selected }),
      });
      setDraft((current) => current ? { ...current, status: 'approved', render_job_id: result.job_id } : current);
      setActiveJob({ id: result.job_id, kind: 'render' });
    } catch (requestError) {
      setStatusText('');
      setError(requestError?.detail || requestError?.message || 'Could not submit approved clips for rendering.');
    }
  };

  const toggleSelected = (clipId) => {
    setSelected((current) => current.includes(clipId)
      ? current.filter((id) => id !== clipId)
      : [...current, clipId]);
  };

  const guideTab = (mode, label) => (
    <button
      key={mode}
      type="button"
      onClick={() => setGuideMode(mode)}
      aria-pressed={guideMode === mode}
      className={`px-3 py-2 text-xs rounded-input border transition-colors ${guideMode === mode ? 'border-brass text-ink bg-paper3' : 'border-rule text-muted hover:text-ink2'}`}
    >{label}</button>
  );

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-8 animate-fade">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-start gap-3 mb-7">
          <div className="w-10 h-10 rounded-card bg-paper3 border border-rule flex items-center justify-center text-brass shrink-0">
            <Clapperboard size={19} aria-hidden="true" />
          </div>
          <div>
            <p className="eyebrow mb-1">CUSTOM WORKFLOW · ANALYZE → REVIEW → APPROVE → RENDER</p>
            <h1 className="font-display lowercase text-2xl text-ink">Custom Clips</h1>
            <p className="text-sm text-muted mt-1 max-w-2xl">Separate from Clip Generator. First we analyze campaign fit and build a draft; no video clips are rendered until you explicitly approve selected candidates.</p>
          </div>
        </div>

        <form onSubmit={startAnalysis} className="card p-4 sm:p-6 space-y-5 mb-6">
          <section>
            <label className="block text-sm font-medium text-ink mb-2">Source video</label>
            <div className="grid md:grid-cols-2 gap-3">
              <label className="flex flex-col gap-2 p-3 rounded-card border border-rule bg-paper2 text-sm text-ink2">
                <span className="flex items-center gap-2"><UploadCloud size={15} className="text-brass" /> Upload a video</span>
                <input type="file" accept="video/*" onChange={(e) => setSourceFile(e.target.files?.[0] || null)} className="text-xs text-muted file:mr-2 file:rounded-input file:border-0 file:bg-paper3 file:px-3 file:py-2 file:text-ink" />
                {sourceFile && <span className="text-xs text-muted truncate">{sourceFile.name}</span>}
              </label>
              <label className="flex flex-col gap-2 p-3 rounded-card border border-rule bg-paper2 text-sm text-ink2">
                <span>Or paste a supported video URL</span>
                <input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://…" className="input w-full" />
              </label>
            </div>
            <p className="text-xs text-muted mt-2">Choose one source only. Upload your own video or one you have permission to use.</p>
          </section>

          <section>
            <div className="flex items-center gap-2 mb-2"><FileText size={15} className="text-brass" /><label className="text-sm font-medium text-ink">Campaign guideline</label></div>
            <div className="flex flex-wrap gap-2 mb-3">{guideTab('text', 'Paste text')}{guideTab('file', 'Upload PDF / TXT / MD')}{guideTab('url', 'Public link')}</div>
            {guideMode === 'text' && <textarea value={guideText} onChange={(e) => setGuideText(e.target.value)} rows={5} maxLength={50000} placeholder="Paste campaign rules, content preferences, prohibited claims, and platform requirements…" className="input w-full resize-y" />}
            {guideMode === 'file' && <input type="file" accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown" onChange={(e) => setGuideFile(e.target.files?.[0] || null)} className="block w-full text-sm text-muted file:mr-3 file:rounded-input file:border-0 file:bg-paper3 file:px-3 file:py-2 file:text-ink" />}
            {guideMode === 'url' && <input type="url" value={guideUrl} onChange={(e) => setGuideUrl(e.target.value)} placeholder="https://public-site.example/guideline.pdf" className="input w-full" />}
            <p className="text-xs text-muted mt-2">Guidelines are used for this draft only. PDF, plain text, Markdown, or readable public pages are supported.</p>
          </section>

          <label className="flex items-start gap-3 text-sm text-ink2">
            <input type="checkbox" checked={rightsAcknowledged} onChange={(e) => setRightsAcknowledged(e.target.checked)} className="mt-1 accent-[var(--brass)]" />
            <span>I own this source video or have permission to process it.</span>
          </label>
          <button type="submit" disabled={isBusy || !eligibleGuideline || (!sourceFile && !sourceUrl.trim()) || !rightsAcknowledged || Boolean(sourceFile && sourceUrl.trim())} className="btn-primary px-4 py-2.5 text-sm disabled:opacity-50">
            {isBusy && activeJob?.kind === 'analysis' ? <Loader2 size={16} className="animate-spin" /> : <Play size={15} />}
            Analyze candidates only
          </button>
        </form>

        {(statusText || error) && <div role={error ? 'alert' : 'status'} className={`mb-6 p-3 rounded-card border text-sm flex items-start gap-2 ${error ? 'border-red-400/40 bg-red-500/5 text-red-300' : 'border-rule bg-paper2 text-ink2'}`}>
          {error ? <AlertCircle size={16} className="shrink-0 mt-0.5" /> : <Loader2 size={16} className={`${isBusy ? 'animate-spin' : ''} shrink-0 mt-0.5`} />}
          <span className="whitespace-pre-line">{error || statusText}</span>
        </div>}

        {draft && <section className="space-y-4 mb-8">
          <div className="card p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="eyebrow">DRAFT REVISION {draft.revision}</p><h2 className="text-lg text-ink font-medium mt-1">Campaign review</h2><p className="text-sm text-muted mt-1">{draft.summary}</p></div>
              <span className="badge-ok">{draft.clips?.length || 0} candidates · no render yet</span>
            </div>
            {draft.campaign_rules?.length > 0 && <div className="grid sm:grid-cols-2 gap-2 mt-4">{draft.campaign_rules.map((rule) => <div key={rule.id} className="p-3 rounded-input bg-paper2 border border-rule text-xs"><div className="flex items-center gap-2 text-ink font-medium"><CheckCircle2 size={14} className={rule.status === 'pass' ? 'text-ok' : 'text-warn'} />{rule.label}<span className="ml-auto text-muted uppercase">{rule.status}</span></div><p className="text-muted mt-1">{rule.reason}</p>{rule.evidence && <p className="text-ink2 mt-1">Evidence: {rule.evidence}</p>}</div>)}</div>}
          </div>

          <div className="grid lg:grid-cols-2 gap-3">
            {(draft.clips || []).map((clip, index) => {
              const checked = selected.includes(clip.id);
              return <article key={clip.id} className={`card p-4 border transition-colors ${checked ? 'border-brass' : 'border-rule'}`}>
                <div className="flex items-start gap-3">
                  <input aria-label={`Select candidate ${index + 1}`} type="checkbox" checked={checked} onChange={() => toggleSelected(clip.id)} disabled={draft.status !== 'draft' || isBusy} className="mt-1 accent-[var(--brass)]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap"><span className="eyebrow">{String(index + 1).padStart(2, '0')} · {clip.start}s–{clip.end}s · {clip.duration}s</span><span className="badge-warn">{clip.pillar}</span></div>
                    <h3 className="text-base font-medium text-ink mt-2">{clip.title}</h3>
                    <p className="text-sm text-brass mt-2">{clip.hook}</p>
                    <p className="text-sm text-muted mt-2">{clip.caption}</p>
                    {clip.evidence && <blockquote className="text-xs text-ink2 border-l-2 border-rule pl-3 mt-3">Source: {clip.evidence}</blockquote>}
                    {clip.checks?.length > 0 && <ul className="mt-3 space-y-1">{clip.checks.map((check, checkIndex) => <li key={`${check.rule_id}-${checkIndex}`} className="text-xs text-muted flex gap-2"><span className={check.status === 'pass' ? 'text-ok' : 'text-warn'}>{check.status}</span><span>{check.reason}{check.evidence ? ` — ${check.evidence}` : ''}</span></li>)}</ul>}
                  </div>
                </div>
              </article>;
            })}
          </div>

          {draft.status === 'draft' && <div className="card p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-3"><MessageCircle size={16} className="text-brass" /><h3 className="text-sm font-medium text-ink">Discuss or revise with AI</h3></div>
            {draft.chat_history?.slice(-6).map((item, index) => <p key={`${item.role}-${index}`} className="text-xs text-muted mb-2"><strong className="text-ink2">{item.role === 'user' ? 'You' : 'AI'}:</strong> {item.content}</p>)}
            <form onSubmit={sendMessage} className="flex flex-col sm:flex-row gap-2">
              <input value={chatMessage} onChange={(e) => setChatMessage(e.target.value)} maxLength={4000} placeholder="Ask to adjust a hook, explain a rule, or revise a candidate…" className="input flex-1" />
              <button type="submit" disabled={busyChat || !chatMessage.trim()} className="btn-quiet px-4 py-2 text-sm disabled:opacity-50">{busyChat ? <Loader2 size={15} className="animate-spin" /> : null}Discuss</button>
            </form>
          </div>}

          {draft.status === 'draft' && <div className="flex flex-wrap items-center justify-between gap-3 card p-4">
            <p className="text-xs text-muted">Select the exact candidates to render. Your approval is checked against this draft revision on the server.</p>
            <button type="button" onClick={approveAndRender} disabled={!selected.length || isBusy} className="btn-primary px-4 py-2.5 text-sm disabled:opacity-50"><CheckCircle2 size={15} />Approve &amp; render selected ({selected.length})</button>
          </div>}
          {draft.status === 'approved' && <div className="card p-4 text-sm text-ink2 border border-ok/40">Approved clips submitted. No other candidates will be rendered.</div>}
        </section>}

        {renderedClips.length > 0 && <section className="space-y-3 mb-8"><h2 className="font-display text-xl lowercase text-ink">Rendered clips</h2><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{renderedClips.map((clip, index) => <article key={clip.video_url || index} className="card p-3"><video controls preload="metadata" src={getApiUrl(clip.video_url)} className="w-full aspect-[9/16] bg-black rounded-input object-contain" /><p className="text-sm text-ink mt-3">{clip.title || `Clip ${index + 1}`}</p><a href={getApiUrl(clip.video_url)} target="_blank" rel="noreferrer" className="text-xs text-brass underline mt-1 inline-block">Open clip</a></article>)}</div></section>}
      </div>
    </div>
  );
}
