import React, { useEffect, useState } from 'react';
import { CalendarDays, Coins, FileText, FolderOpen, Link2, Loader2, Plus, Save, Sparkles, Trash2, UploadCloud, Wand2 } from 'lucide-react';
import { apiFetch, apiJson } from '../lib/api';
import { getApiUrl } from '../config';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Self-host BYOK: only the AI rule-parsing call needs the key header.
const geminiHeaders = () => {
  const key = localStorage.getItem('gemini_key');
  return key ? { 'X-Gemini-Key': key } : {};
};

async function sendForm(path, form) {
  const response = await apiFetch(path, { method: 'POST', body: form });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : `Request failed (${response.status})`;
    throw new Error(detail);
  }
  return payload;
}

// Underline tabs, same pattern as the clip generator's Upload File / Video URL.
const Tabs = ({ tabs, active, onChange }) => (
  <div className="flex gap-4 sm:gap-6 mb-5 border-b border-rule">
    {tabs.map(({ id, label, icon: Icon }) => (
      <button
        key={id}
        type="button"
        onClick={() => onChange(id)}
        aria-pressed={active === id}
        className={`flex items-center gap-2 pb-3 px-1 -mb-px border-b-2 text-sm lowercase whitespace-nowrap transition-colors ${active === id
          ? 'text-ink border-brass'
          : 'text-muted border-transparent hover:text-ink2'
          }`}
      >
        <Icon size={16} className={`hidden sm:block ${active === id ? 'text-brass' : ''}`} />
        {label}
      </button>
    ))}
  </div>
);

const SectionHead = ({ icon: Icon, eyebrow, title }) => (
  <div className="flex items-center gap-2 mb-3">
    <Icon size={15} className="text-brass" />
    <div>
      <p className="eyebrow">{eyebrow}</p>
      <h3 className="text-sm font-medium text-ink">{title}</h3>
    </div>
  </div>
);

const ASSET_KINDS = ['footage', 'logo', 'other'];

export default function Campaigns({ onOpenDraft }) {
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [statusText, setStatusText] = useState('');
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', platform: '', reward: '', deadline: '', brief_link: '', guideline_text: '', guideline_url: '' });
  // Guideline panel: paste text or pull from a public URL.
  const [guideMode, setGuideMode] = useState('text');
  const [guideFile, setGuideFile] = useState(null);
  const [guidelineDraft, setGuidelineDraft] = useState('');
  const [guideUrl, setGuideUrl] = useState('');
  // Asset panel: upload a file or register a public URL.
  const [assetMode, setAssetMode] = useState('file');
  const [assetKind, setAssetKind] = useState('footage');
  const [assetNote, setAssetNote] = useState('');
  const [assetUrl, setAssetUrl] = useState('');
  const [assetFile, setAssetFile] = useState(null);

  const refresh = async () => {
    const data = await apiJson('/api/campaigns');
    setCampaigns(data.campaigns || []);
    return data.campaigns || [];
  };

  useEffect(() => {
    let cancelled = false;
    refresh().catch((e) => !cancelled && setError(e?.message || 'Could not load campaigns.')).finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const openCampaign = async (id) => {
    setError('');
    try {
      const campaign = await apiJson(`/api/campaigns/${encodeURIComponent(id)}`);
      setSelected(campaign);
      setGuidelineDraft(campaign.guideline_text || '');
      setGuideUrl(campaign.guideline_url || '');
      setGuideMode(campaign.guideline_text ? 'text' : (campaign.guideline_url ? 'url' : 'text'));
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not open the campaign.');
    }
  };

  const createCampaign = async (event) => {
    event.preventDefault();
    setError('');
    setBusy('create');
    try {
      const campaign = await apiJson('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newForm) });
      setNewForm({ name: '', platform: '', reward: '', deadline: '', brief_link: '', guideline_text: '', guideline_url: '' });
      setCreating(false);
      await refresh();
      setSelected(campaign);
      setGuidelineDraft(campaign.guideline_text || '');
      setGuideUrl(campaign.guideline_url || '');
      setGuideMode(campaign.guideline_text ? 'text' : (campaign.guideline_url ? 'url' : 'text'));
      setStatusText('Campaign created. Extract the guideline into rules next.');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not create the campaign.');
    } finally {
      setBusy('');
    }
  };

  const saveMeta = async () => {
    if (!selected) return;
    setBusy('save');
    setError('');
    try {
      const updated = await apiJson(`/api/campaigns/${encodeURIComponent(selected.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selected, guideline_text: guidelineDraft, guideline_url: guideUrl }),
      });
      setSelected(updated);
      setGuidelineDraft(updated.guideline_text || '');
      setGuideUrl(updated.guideline_url || '');
      await refresh();
      setStatusText('Campaign saved.');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not save the campaign.');
    } finally {
      setBusy('');
    }
  };

  const applyUpdated = (updated, message) => {
    setSelected(updated);
    setGuidelineDraft(updated.guideline_text || '');
    setGuideUrl(updated.guideline_url || '');
    refresh();
    setStatusText(message);
  };

  const parseGuideline = async () => {
    if (!selected) return;
    setError('');
    const payload = guideMode === 'url'
      ? { guideline_url: guideUrl.trim(), guideline_text: '' }
      : { guideline_text: guidelineDraft };
    if (guideMode === 'url' && !payload.guideline_url) {
      setError('Paste the public guideline URL first.');
      return;
    }
    if (guideMode === 'text' && !payload.guideline_text.trim()) {
      setError('Paste the campaign guideline first.');
      return;
    }
    setBusy('parse');
    try {
      const updated = await apiJson(`/api/campaigns/${encodeURIComponent(selected.id)}/parse-guideline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiHeaders() },
        body: JSON.stringify(payload),
      });
      const count = (updated.rules || []).length;
      applyUpdated(updated, count ? `Extracted ${count} rule(s) from the guideline.` : 'The AI returned no rules; refine the guideline text.');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not parse the guideline.');
    } finally {
      setBusy('');
    }
  };

  const parseGuidelineFile = async () => {
    if (!selected || !guideFile) {
      setError('Choose a guideline file first.');
      return;
    }
    setBusy('parse');
    setError('');
    try {
      const form = new FormData();
      form.append('file', guideFile);
      const updated = await sendForm(`/api/campaigns/${encodeURIComponent(selected.id)}/parse-guideline-file`, form);
      const count = (updated.rules || []).length;
      applyUpdated(updated, count ? `Extracted ${count} rule(s) from the file.` : 'The AI returned no rules; try a clearer guideline file.');
      setGuideFile(null);
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not parse the guideline file.');
    } finally {
      setBusy('');
    }
  };

  const saveGuidelineUrl = async () => {
    if (!selected) return;
    setBusy('save-url');
    setError('');
    try {
      const updated = await apiJson(`/api/campaigns/${encodeURIComponent(selected.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selected, guideline_text: guidelineDraft, guideline_url: guideUrl }),
      });
      applyUpdated(updated, 'Guideline link saved.');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not save the guideline link.');
    } finally {
      setBusy('');
    }
  };

  const submitAsset = async () => {
    if (!selected) return;
    setError('');
    if (assetMode === 'file' && !assetFile) {
      setError('Choose a file to upload first.');
      return;
    }
    if (assetMode === 'url' && !assetUrl.trim()) {
      setError('Paste the asset URL first.');
      return;
    }
    setBusy('asset');
    try {
      let updated;
      if (assetMode === 'file') {
        const form = new FormData();
        form.append('file', assetFile);
        form.append('kind', assetKind);
        form.append('note', assetNote);
        updated = await sendForm(`/api/campaigns/${encodeURIComponent(selected.id)}/assets`, form);
      } else {
        updated = await apiJson(`/api/campaigns/${encodeURIComponent(selected.id)}/assets-from-url`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: assetUrl.trim(), kind: assetKind, note: assetNote }),
        });
      }
      setSelected(updated);
      await refresh();
      setStatusText(`Asset added (${assetKind}).`);
      setAssetUrl('');
      setAssetFile(null);
      setAssetNote('');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not add the asset.');
    } finally {
      setBusy('');
    }
  };

  const removeAsset = async (assetId) => {
    if (!selected) return;
    setBusy(`asset-${assetId}`);
    setError('');
    try {
      const updated = await apiJson(`/api/campaigns/${encodeURIComponent(selected.id)}/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
      setSelected(updated);
      await refresh();
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not remove the asset.');
    } finally {
      setBusy('');
    }
  };

  const deleteCampaign = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete campaign "${selected.name}"? Assets and links are removed; rendered clips stay.`)) return;
    setBusy('delete');
    setError('');
    try {
      await apiJson(`/api/campaigns/${encodeURIComponent(selected.id)}`, { method: 'DELETE' });
      setSelected(null);
      await refresh();
      setStatusText('Campaign deleted.');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not delete the campaign.');
    } finally {
      setBusy('');
    }
  };

  const analyzeForCampaign = (campaign) => {
    try { localStorage.setItem('custom_clips_campaign', campaign.id); } catch (_) { /* private mode */ }
    onOpenDraft?.();
  };

  const openDraftInEditor = (draftId) => {
    try { localStorage.setItem('custom_clips_resume', draftId); } catch (_) { /* private mode */ }
    onOpenDraft?.(draftId);
  };

  if (loading) {
    return <div className="p-8 flex items-center gap-2 text-muted"><Loader2 size={16} className="animate-spin" />Loading campaigns…</div>;
  }

  return (
    <div className="h-full overflow-y-auto custom-scrollbar p-4 sm:p-8 animate-fade">
      <div className="max-w-5xl mx-auto space-y-4 pb-20 md:pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="eyebrow">CAMPAIGN WORKSPACE</p>
            <h2 className="text-lg text-ink font-medium">Content-rewards campaigns</h2>
            <p className="text-sm text-muted mt-1">Rules, footage, logos and notes per campaign — drafts made here inherit its rules.</p>
          </div>
          <div className="flex gap-2">
            {selected && <button type="button" onClick={() => setSelected(null)} className="btn-quiet px-3 py-2 text-sm">All campaigns</button>}
            <button type="button" onClick={() => setCreating((v) => !v)} className="btn-primary px-3 py-2 text-sm"><Plus size={15} />New campaign</button>
          </div>
        </div>

        {error && <div className="card p-3 text-sm text-warn flex items-start gap-2"><span className="text-warn mt-0.5">⚠</span><span>{error}</span></div>}
        {statusText && <div className="text-xs text-muted">{statusText}</div>}

        {creating && (
          <form onSubmit={createCampaign} className="card p-4 sm:p-6 space-y-4">
            <SectionHead icon={FolderOpen} eyebrow="NEW CAMPAIGN" title="Campaign details" />
            <div className="grid sm:grid-cols-2 gap-4">
              <label className="block sm:col-span-2"><span className="text-sm font-medium text-ink">Campaign name</span><input required value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} maxLength={120} className="input-field mt-2 w-full" placeholder="Clippo — October fitness brief" /></label>
              <label className="block"><span className="text-sm font-medium text-ink">Platform</span><input value={newForm.platform} onChange={(e) => setNewForm({ ...newForm, platform: e.target.value })} maxLength={200} className="input-field mt-2 w-full" placeholder="contentrewards / clippo.id" /></label>
              <label className="block"><span className="text-sm font-medium text-ink">Reward</span><input value={newForm.reward} onChange={(e) => setNewForm({ ...newForm, reward: e.target.value })} maxLength={200} className="input-field mt-2 w-full" placeholder="$100 per accepted clip" /></label>
              <label className="block"><span className="text-sm font-medium text-ink">Deadline</span><input value={newForm.deadline} onChange={(e) => setNewForm({ ...newForm, deadline: e.target.value })} maxLength={200} className="input-field mt-2 w-full" placeholder="2026-10-31" /></label>
              <label className="block"><span className="text-sm font-medium text-ink">Brief link</span><input value={newForm.brief_link} onChange={(e) => setNewForm({ ...newForm, brief_link: e.target.value })} maxLength={500} className="input-field mt-2 w-full" placeholder="https://…" /></label>
            </div>
            <div>
              <span className="text-sm font-medium text-ink">Guideline (optional now)</span>
              <textarea value={newForm.guideline_text} onChange={(e) => setNewForm({ ...newForm, guideline_text: e.target.value })} maxLength={50000} rows={4} className="input-field mt-2 w-full resize-y" placeholder="Paste the rules, or add them after creating the campaign." />
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setCreating(false)} className="btn-quiet px-3 py-2 text-sm">Cancel</button>
              <button type="submit" disabled={busy === 'create'} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">{busy === 'create' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}Create campaign</button>
            </div>
          </form>
        )}

        {!selected && campaigns.length === 0 && !creating && (
          <div className="card p-8 text-center text-sm text-muted">
            <FolderOpen size={22} className="mx-auto mb-2 text-muted" />
            No campaigns yet. Create one per content-rewards brief, paste its guideline, and every draft analysis will inherit its rules.
          </div>
        )}

        {!selected && campaigns.length > 0 && (
          <div className="grid sm:grid-cols-2 gap-3">
            {campaigns.map((campaign) => (
              <button key={campaign.id} type="button" onClick={() => openCampaign(campaign.id)} className="card p-4 text-left hover:border-brass transition-colors">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm text-ink font-medium truncate">{campaign.name}</h3>
                  <span className="readout">{(campaign.rules || []).length} rules</span>
                </div>
                <div className="flex flex-wrap gap-3 mt-2 text-xs text-muted">
                  {campaign.platform && <span>{campaign.platform}</span>}
                  {campaign.reward && <span className="flex items-center gap-1"><Coins size={12} />{campaign.reward}</span>}
                  {campaign.deadline && <span className="flex items-center gap-1"><CalendarDays size={12} />{campaign.deadline}</span>}
                  <span>{(campaign.assets || []).length} assets · {(campaign.drafts || []).length} drafts</span>
                </div>
              </button>
            ))}
          </div>
        )}

        {selected && (
          <div className="space-y-4">
            <div className="card p-4 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="eyebrow">CAMPAIGN</p>
                  <h3 className="text-base text-ink font-medium">{selected.name}</h3>
                  <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted">
                    {selected.platform && <span>{selected.platform}</span>}
                    {selected.reward && <span className="flex items-center gap-1"><Coins size={12} />{selected.reward}</span>}
                    {selected.deadline && <span className="flex items-center gap-1"><CalendarDays size={12} />{selected.deadline}</span>}
                    {selected.brief_link && <a href={selected.brief_link} target="_blank" rel="noopener noreferrer" className="text-brass underline">brief</a>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => analyzeForCampaign(selected)} className="btn-primary px-3 py-2 text-sm"><Sparkles size={14} />New analysis</button>
                  <button type="button" onClick={deleteCampaign} disabled={busy === 'delete'} className="btn-quiet px-3 py-2 text-sm disabled:opacity-50"><Trash2 size={14} />Delete</button>
                </div>
              </div>
            </div>

            <div className="card p-4 sm:p-6">
              <SectionHead icon={FileText} eyebrow="GUIDELINE & RULES" title="AI-extracted, reusable checks" />
              <Tabs
                tabs={[
                  { id: 'text', label: 'Paste text', icon: FileText },
                  { id: 'file', label: 'Upload file', icon: UploadCloud },
                  { id: 'url', label: 'Public link', icon: Link2 },
                ]}
                active={guideMode}
                onChange={setGuideMode}
              />
              {guideMode === 'text' && (
                <>
                  <textarea value={guidelineDraft} onChange={(e) => setGuidelineDraft(e.target.value)} maxLength={50000} rows={6} placeholder="Paste the campaign guideline here…" className="input-field w-full resize-y" />
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button type="button" onClick={saveMeta} disabled={busy === 'save'} className="btn-quiet px-3 py-2 text-xs disabled:opacity-50"><Save size={13} />Save guideline</button>
                    <button type="button" onClick={parseGuideline} disabled={busy === 'parse' || !guidelineDraft.trim()} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">{busy === 'parse' ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}Extract rules with AI</button>
                  </div>
                </>
              )}
              {guideMode === 'file' && (
                <>
                  <input type="file" accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown" onChange={(e) => setGuideFile(e.target.files?.[0] || null)} className="block w-full text-sm text-muted file:mr-3 file:rounded-input file:border-0 file:bg-paper3 file:px-3 file:py-2 file:text-ink" />
                  <p className="text-xs text-muted mt-2">PDF, plain text and Markdown are supported — the most reliable way in, no sharing permissions needed.</p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button type="button" onClick={parseGuidelineFile} disabled={busy === 'parse' || !guideFile} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">{busy === 'parse' ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}Extract rules from file</button>
                  </div>
                </>
              )}
              {guideMode === 'url' && (
                <>
                  <input type="url" value={guideUrl} onChange={(e) => setGuideUrl(e.target.value)} maxLength={500} placeholder="https://public-site.example/guideline.pdf" className="input-field w-full" />
                  <p className="text-xs text-muted mt-2">Readable public pages, PDF, plain text and Markdown are fetched by the server — a link that needs sign-in (e.g. a Drive viewer page) will not extract.</p>
                  <div className="flex flex-wrap gap-2 mt-3">
                    <button type="button" onClick={saveGuidelineUrl} disabled={busy === 'save-url' || !guideUrl.trim()} className="btn-quiet px-3 py-2 text-xs disabled:opacity-50"><Save size={13} />Save link</button>
                    <button type="button" onClick={parseGuideline} disabled={busy === 'parse' || !guideUrl.trim()} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">{busy === 'parse' ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}Fetch &amp; extract rules</button>
                  </div>
                </>
              )}
              {(selected.rules || []).length > 0 && (
                <ul className="mt-4 space-y-2">
                  {selected.rules.map((rule) => (
                    <li key={rule.id} className="p-3 rounded-input bg-paper2 border border-rule text-xs">
                      <p className="text-ink font-medium">{rule.label}</p>
                      {rule.description && <p className="text-muted mt-1">{rule.description}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card p-4 sm:p-6">
              <SectionHead icon={UploadCloud} eyebrow="ASSETS" title="Footage, logos and usage notes" />
              <Tabs
                tabs={[
                  { id: 'file', label: 'Upload file', icon: UploadCloud },
                  { id: 'url', label: 'From URL', icon: Link2 },
                ]}
                active={assetMode}
                onChange={setAssetMode}
              />
              {assetMode === 'file' && (
                <input type="file" onChange={(e) => setAssetFile(e.target.files?.[0] || null)} className="block w-full text-sm text-muted file:mr-3 file:rounded-input file:border-0 file:bg-paper3 file:px-3 file:py-2 file:text-ink" />
              )}
              {assetMode === 'url' && (
                <input type="url" value={assetUrl} onChange={(e) => setAssetUrl(e.target.value)} maxLength={2000} placeholder="https://example.com/footage-clip.mp4" className="input-field w-full" />
              )}
              <div className="grid sm:grid-cols-[10rem_minmax(0,1fr)] gap-3 mt-3">
                <label className="block"><span className="text-xs text-muted">Kind</span>
                  <select value={assetKind} onChange={(e) => setAssetKind(e.target.value)} className="input-field mt-1 w-full">
                    {ASSET_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                  </select>
                </label>
                <label className="block"><span className="text-xs text-muted">Usage note (optional)</span>
                  <input value={assetNote} onChange={(e) => setAssetNote(e.target.value)} maxLength={1000} className="input-field mt-1 w-full" placeholder="e.g. main b-roll, cleared for this campaign" />
                </label>
              </div>
              <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" onClick={submitAsset} disabled={busy === 'asset'} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">{busy === 'asset' ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}{assetMode === 'file' ? 'Add asset' : 'Add asset from URL'}</button>
                <span className="text-xs text-muted self-center">Add as many assets as the campaign needs.</span>
              </div>
              {(selected.assets || []).length > 0 && (
                <ul className="mt-4 space-y-2">
                  {selected.assets.map((asset) => (
                    <li key={asset.id} className="p-3 rounded-input bg-paper2 border border-rule text-xs flex items-start gap-2">
                      <FileText size={13} className="mt-0.5 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <p className="text-ink truncate">{asset.filename}</p>
                        <p className="text-muted mt-0.5">{asset.kind}{asset.note ? ` · ${asset.note}` : ''}</p>
                      </div>
                      <button type="button" onClick={() => removeAsset(asset.id)} disabled={busy === `asset-${asset.id}`} className="text-muted hover:text-warn shrink-0" aria-label={`Remove ${asset.filename}`}><Trash2 size={13} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card p-4 sm:p-6">
              <SectionHead icon={FolderOpen} eyebrow="DRAFT ANALYSES" title="Drafts made from this campaign" />
              {(selected.drafts || []).length === 0
                ? <p className="text-xs text-muted">None yet — start a new analysis above.</p>
                : (
                  <ul className="space-y-2">
                    {selected.drafts.map((draftId) => (
                      <li key={draftId} className="p-3 rounded-input bg-paper2 border border-rule text-xs flex items-center justify-between gap-2">
                        <span className="text-ink truncate">{draftId}</span>
                        <button type="button" onClick={() => openDraftInEditor(draftId)} className="btn-quiet px-2.5 py-1.5 text-xs shrink-0">Open in Custom Clips</button>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
