import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clapperboard, FileText, Loader2, MessageCircle, Play, Plus, Save, Trash2, UploadCloud } from 'lucide-react';
import { apiFetch, apiJson } from '../lib/api';
import { getApiUrl } from '../config';

async function sendForm(path, form) {
  const response = await apiFetch(path, { method: 'POST', body: form, headers: geminiHeaders() });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return payload;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Self-host BYOK: analyze, chat and approve resolve the AI key from this header.
// Settings persists it under the `gemini_key` localStorage entry (see App.jsx).
const geminiHeaders = () => {
  const key = localStorage.getItem('gemini_key');
  return key ? { 'X-Gemini-Key': key } : {};
};

export default function CustomClips() {
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [guideMode, setGuideMode] = useState('text');
  const [guideFile, setGuideFile] = useState(null);
  const [guideUrl, setGuideUrl] = useState('');
  const [guideText, setGuideText] = useState('');
  const [campaignAiModels, setCampaignAiModels] = useState([{ id: 'gemini', provider: 'Gemini', model: 'gemini-3.1-flash-lite' }]);
  const [aiProvider, setAiProvider] = useState('gemini');
  const [rightsAcknowledged, setRightsAcknowledged] = useState(false);
  const [draft, setDraft] = useState(null);
  const [selected, setSelected] = useState([]);
  const [chatMessage, setChatMessage] = useState('');
  const [busyChat, setBusyChat] = useState(false);
  const [savingEdits, setSavingEdits] = useState(false);
  const [hasUnsavedEdits, setHasUnsavedEdits] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [statusText, setStatusText] = useState('');
  const [error, setError] = useState('');
  const [renderedClips, setRenderedClips] = useState([]);
  const [sourcePreviewUrl, setSourcePreviewUrl] = useState('');
  const [sourcePreviewError, setSourcePreviewError] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [previewRange, setPreviewRange] = useState(null);
  const sourceVideoRef = useRef(null);

  const isBusy = Boolean(activeJob);
  const eligibleGuideline = useMemo(() => {
    if (guideMode === 'file') return Boolean(guideFile);
    if (guideMode === 'url') return Boolean(guideUrl.trim());
    return Boolean(guideText.trim());
  }, [guideFile, guideMode, guideText, guideUrl]);

  useEffect(() => {
    let cancelled = false;
    apiJson('/api/config').then((config) => {
      if (cancelled) return;
      const models = Array.isArray(config.campaignAiModels) && config.campaignAiModels.length
        ? config.campaignAiModels
        : [{ id: 'gemini', provider: 'Gemini', model: 'gemini-3.1-flash-lite' }];
      setCampaignAiModels(models);
      const defaultProvider = models.some((item) => item.id === config.defaultCampaignAiProvider)
        ? config.defaultCampaignAiProvider
        : models[0].id;
      setAiProvider(defaultProvider);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!draft?.id) {
      setSourcePreviewUrl('');
      setSourcePreviewError('');
      setCurrentTime(0);
      setPreviewRange(null);
      return undefined;
    }
    let cancelled = false;
    apiJson(`/api/custom/drafts/${encodeURIComponent(draft.id)}/source-url`)
      .then(({ url }) => {
        if (!cancelled) setSourcePreviewUrl(getApiUrl(url));
      })
      .catch((previewError) => {
        if (!cancelled) setError(previewError?.detail || previewError?.message || 'Could not load the source video preview.');
      });
    return () => { cancelled = true; };
  }, [draft?.id]);

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
              setHasUnsavedEdits(false);
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
    if (aiProvider === 'gemini' && !localStorage.getItem('gemini_key')) {
      setError('Add your Gemini API key in Settings first — the analyze request needs it.');
      setStatusText('');
      return;
    }
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
      form.append('ai_provider', aiProvider);
      const job = await sendForm('/api/custom/analyze', form);
      setDraft(null);
      setSelected([]);
      setHasUnsavedEdits(false);
      setActiveJob({ id: job.draft_id || job.job_id, kind: 'analysis' });
    } catch (requestError) {
      setStatusText('');
      setError(requestError?.message || 'Could not start campaign analysis.');
    }
  };

  const updateCandidate = (key, changes) => {
    setDraft((current) => current ? {
      ...current,
      clips: (current.clips || []).map((clip) => (clip.id || clip.clientKey) === key ? { ...clip, ...changes } : clip),
    } : current);
    setHasUnsavedEdits(true);
  };

  const addCandidate = () => {
    if (!draft || draft.status !== 'draft') return;
    const key = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const end = Math.min(15, Number(draft.video_duration) || 15);
    setDraft((current) => current ? {
      ...current,
      clips: [...(current.clips || []), {
        clientKey: key, start: 0, end, duration: end, title: 'Manual candidate',
        hook: '', caption: '', pillar: 'Manual', evidence: '', checks: [],
      }],
    } : current);
    setHasUnsavedEdits(true);
  };

  const removeCandidate = (key) => {
    setDraft((current) => current ? {
      ...current,
      clips: (current.clips || []).filter((clip) => (clip.id || clip.clientKey) !== key),
    } : current);
    setSelected((current) => current.filter((id) => id !== key));
    setHasUnsavedEdits(true);
  };

  const previewCandidate = async (clip) => {
    const player = sourceVideoRef.current;
    if (!player || !sourcePreviewUrl || Number(clip.end) <= Number(clip.start)) return;
    player.currentTime = Number(clip.start);
    setPreviewRange({ id: clip.id || clip.clientKey, end: Number(clip.end) });
    try {
      await player.play();
    } catch (_) {
      setPreviewRange(null);
      setError('The browser could not play this source video. Check the format or codec.');
    }
  };

  const handlePreviewTimeUpdate = () => {
    const player = sourceVideoRef.current;
    if (!player) return;
    setCurrentTime(player.currentTime);
    if (previewRange && player.currentTime >= previewRange.end) {
      player.pause();
      setPreviewRange(null);
    }
  };

  const setCandidateBoundaryFromPlayhead = (clip, field) => {
    const key = clip.id || clip.clientKey;
    const time = Math.round(currentTime * 10) / 10;
    const start = field === 'start' ? time : Number(clip.start);
    const end = field === 'end' ? time : Number(clip.end);
    updateCandidate(key, { [field]: time, duration: Math.max(0, end - start) });
  };

  const saveCandidateEdits = async () => {
    if (!draft || savingEdits || !hasUnsavedEdits) return;
    setSavingEdits(true);
    setError('');
    try {
      const result = await apiJson(`/api/custom/drafts/${encodeURIComponent(draft.id)}/clips`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: draft.revision,
          clips: (draft.clips || []).map(({ id, start, end, title, hook, caption, pillar }) => ({ id, start, end, title, hook, caption, pillar })),
        }),
      });
      setDraft(result);
      const validIds = new Set((result.clips || []).map((clip) => clip.id));
      setSelected((current) => current.filter((id) => validIds.has(id)));
      setHasUnsavedEdits(false);
      setStatusText('Edits saved. Review the refreshed compliance checks and select clips to render.');
    } catch (requestError) {
      setError(requestError?.detail || requestError?.message || 'Could not save candidate edits.');
    } finally {
      setSavingEdits(false);
    }
  };

  const sendMessage = async (event) => {
    event.preventDefault();
    if (!draft || !chatMessage.trim() || busyChat || hasUnsavedEdits) return;
    setBusyChat(true);
    setError('');
    try {
      const result = await apiJson(`/api/custom/drafts/${encodeURIComponent(draft.id)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiHeaders() },
        body: JSON.stringify({ revision: draft.revision, message: chatMessage.trim() }),
      });
      setDraft(result.draft);
      setSelected([]);
      setHasUnsavedEdits(false);
      setChatMessage('');
      setStatusText('Draft revised. Please review and select candidates again.');
    } catch (requestError) {
      setError(requestError?.detail || requestError?.message || 'Could not revise the draft.');
    } finally {
      setBusyChat(false);
    }
  };

  const approveAndRender = async () => {
    if (!draft || !selected.length || isBusy || hasUnsavedEdits || savingEdits) return;
    const confirmed = window.confirm(`Render ${selected.length} selected candidate(s)? Only these approved ranges will be rendered.`);
    if (!confirmed) return;
    setError('');
    setStatusText('Submitting the approved render…');
    try {
      const result = await apiJson(`/api/custom/drafts/${encodeURIComponent(draft.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiHeaders() },
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

          <section>
            <label htmlFor="campaign-ai-provider" className="block text-sm font-medium text-ink mb-2">AI model for this campaign</label>
            <select id="campaign-ai-provider" value={aiProvider} onChange={(e) => setAiProvider(e.target.value)} className="input w-full sm:max-w-md">
              {campaignAiModels.map((item) => (
                <option key={item.id} value={item.id}>{item.provider} · {item.model}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-2">Options come from this server's configuration. OpenAI-compatible includes OpenAI API, OpenRouter, or a local model endpoint when configured.</p>
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
            <p className="text-xs text-muted mt-3">AI: {draft.ai_provider || 'configured provider'} · {draft.ai_model || 'default model'}</p>
            {draft.campaign_rules?.length > 0 && <div className="grid sm:grid-cols-2 gap-2 mt-4">{draft.campaign_rules.map((rule) => <div key={rule.id} className="p-3 rounded-input bg-paper2 border border-rule text-xs"><div className="flex items-center gap-2 text-ink font-medium"><CheckCircle2 size={14} className={rule.status === 'pass' ? 'text-ok' : 'text-warn'} />{rule.label}<span className="ml-auto text-muted uppercase">{rule.status}</span></div><p className="text-muted mt-1">{rule.reason}</p>{rule.evidence && <p className="text-ink2 mt-1">Evidence: {rule.evidence}</p>}</div>)}</div>}
          </div>

          <div className="card p-4 sm:p-5 grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4 items-center">
            <div className="flex justify-center bg-black/30 rounded-input overflow-hidden min-h-40">
              {sourcePreviewUrl
                ? <video ref={sourceVideoRef} src={sourcePreviewUrl} controls preload="metadata" onTimeUpdate={handlePreviewTimeUpdate} onPause={() => setPreviewRange(null)} onError={() => setError('Could not load the source preview. The upload may have expired or use an unsupported format.')} className="w-full max-h-[28rem] object-contain" />
                : <p className="self-center text-xs text-muted p-4">Loading source preview…</p>}
            </div>
            <div>
              <p className="eyebrow">SOURCE PREVIEW</p>
              <h3 className="text-base text-ink font-medium mt-1">Check the exact moment before rendering</h3>
              <p className="text-sm text-muted mt-2">Player position: <span className="text-ink tabular-nums">{currentTime.toFixed(1)}s</span>. Use candidate controls to preview its range or set a boundary from the playhead.</p>
              <p className="text-xs text-muted mt-2">Playback uses the original uploaded/downloaded source. No render starts from preview.</p>
            </div>
          </div>

          {draft.status === 'draft' && <div className="flex flex-wrap items-center justify-between gap-3 card p-4">
            <div><h3 className="text-sm font-medium text-ink">Edit clip plan</h3><p className="text-xs text-muted mt-1">Adjust timeline, title, hook and caption. Timing edits may change compliance checks.</p></div>
            <div className="flex gap-2">
              <button type="button" onClick={addCandidate} disabled={isBusy || savingEdits || (draft.clips || []).length >= 50} className="btn-quiet px-3 py-2 text-sm disabled:opacity-50"><Plus size={15} />Add manual candidate</button>
              <button type="button" onClick={saveCandidateEdits} disabled={!hasUnsavedEdits || savingEdits || isBusy} className="btn-primary px-3 py-2 text-sm disabled:opacity-50">{savingEdits ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}Save edits</button>
            </div>
          </div>}
          {hasUnsavedEdits && <p className="text-xs text-warn px-1">You have unsaved edits. Save before discussing with AI or approving a render.</p>}

          <div className="grid lg:grid-cols-2 gap-3">
            {(draft.clips || []).map((clip, index) => {
              const key = clip.id || clip.clientKey;
              const checked = selected.includes(clip.id);
              const editable = draft.status === 'draft';
              return <article key={key} className={`card p-4 border transition-colors ${checked ? 'border-brass' : 'border-rule'}`}>
                <div className="flex items-start gap-3">
                  <input aria-label={`Select candidate ${index + 1}`} type="checkbox" checked={checked} onChange={() => toggleSelected(clip.id)} disabled={!clip.id || !editable || isBusy || savingEdits || hasUnsavedEdits} className="mt-1 accent-[var(--brass)]" />
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="eyebrow">{String(index + 1).padStart(2, '0')} · {clip.duration}s · {clip.pillar}</span>
                      {editable && <button type="button" onClick={() => removeCandidate(key)} aria-label={`Remove candidate ${index + 1}`} disabled={savingEdits || isBusy} className="text-muted hover:text-red-300 disabled:opacity-50"><Trash2 size={15} /></button>}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="text-xs text-muted">Start (seconds)<input aria-label={`Candidate ${index + 1} start time in seconds`} type="number" min="0" max={draft.video_duration} step="0.1" value={clip.start} disabled={!editable || isBusy || savingEdits} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && updateCandidate(key, { start: e.target.valueAsNumber, duration: Math.max(0, Number(clip.end) - e.target.valueAsNumber) })} className="input mt-1 w-full" /></label>
                      <label className="text-xs text-muted">End (seconds)<input aria-label={`Candidate ${index + 1} end time in seconds`} type="number" min="0" max={draft.video_duration} step="0.1" value={clip.end} disabled={!editable || isBusy || savingEdits} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && updateCandidate(key, { end: e.target.valueAsNumber, duration: Math.max(0, e.target.valueAsNumber - Number(clip.start)) })} className="input mt-1 w-full" /></label>
                    </div>
                    <label className="block text-xs text-muted">Title<input aria-label={`Candidate ${index + 1} title`} value={clip.title} disabled={!editable || isBusy || savingEdits} onChange={(e) => updateCandidate(key, { title: e.target.value })} maxLength={160} className="input mt-1 w-full" /></label>
                    <label className="block text-xs text-muted">Hook<input aria-label={`Candidate ${index + 1} hook`} value={clip.hook} disabled={!editable || isBusy || savingEdits} onChange={(e) => updateCandidate(key, { hook: e.target.value })} maxLength={300} className="input mt-1 w-full" /></label>
                    <label className="block text-xs text-muted">Caption<textarea aria-label={`Candidate ${index + 1} caption`} value={clip.caption} disabled={!editable || isBusy || savingEdits} onChange={(e) => updateCandidate(key, { caption: e.target.value })} maxLength={2000} rows={3} className="input mt-1 w-full resize-y" /></label>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => previewCandidate(clip)} disabled={!sourcePreviewUrl || isBusy || Number(clip.end) <= Number(clip.start)} className="btn-quiet px-2.5 py-1.5 text-xs disabled:opacity-50"><Play size={13} />Preview range</button>
                      {editable && <>
                        <button type="button" onClick={() => setCandidateBoundaryFromPlayhead(clip, 'start')} disabled={!sourcePreviewUrl || isBusy || savingEdits} className="btn-quiet px-2.5 py-1.5 text-xs disabled:opacity-50">Set start · {currentTime.toFixed(1)}s</button>
                        <button type="button" onClick={() => setCandidateBoundaryFromPlayhead(clip, 'end')} disabled={!sourcePreviewUrl || isBusy || savingEdits} className="btn-quiet px-2.5 py-1.5 text-xs disabled:opacity-50">Set end · {currentTime.toFixed(1)}s</button>
                      </>}
                    </div>
                    {clip.evidence && <blockquote className="text-xs text-ink2 border-l-2 border-rule pl-3">Source: {clip.evidence}</blockquote>}
                    {clip.checks?.length > 0 && <ul className="space-y-1">{clip.checks.map((check, checkIndex) => <li key={`${check.rule_id}-${checkIndex}`} className="text-xs text-muted flex gap-2"><span className={check.status === 'pass' ? 'text-ok' : 'text-warn'}>{check.status}</span><span>{check.reason}{check.evidence ? ` — ${check.evidence}` : ''}</span></li>)}</ul>}
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
              <button type="submit" disabled={busyChat || !chatMessage.trim() || hasUnsavedEdits || savingEdits} className="btn-quiet px-4 py-2 text-sm disabled:opacity-50">{busyChat ? <Loader2 size={15} className="animate-spin" /> : null}Discuss</button>
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
