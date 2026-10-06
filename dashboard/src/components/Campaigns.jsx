import React, { useEffect, useState } from 'react';
import { CalendarDays, Coins, FileText, FolderOpen, Loader2, Plus, Save, Sparkles, Trash2, UploadCloud, Wand2 } from 'lucide-react';
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

export default function Campaigns({ onOpenDraft }) {
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [statusText, setStatusText] = useState('');
  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({ name: '', platform: '', reward: '', deadline: '', brief_link: '', guideline_text: '' });
  const [guidelineDraft, setGuidelineDraft] = useState('');

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
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not open the campaign.');
    }
  };

  const createCampaign = async (event) => {
    event.preventDefault();
    setError('');
    setBusy('create');
    try {
      const campaign = await apiJson('/api/campaigns', { method: 'POST', body: JSON.stringify(newForm) });
      setNewForm({ name: '', platform: '', reward: '', deadline: '', brief_link: '', guideline_text: '' });
      setCreating(false);
      await refresh();
      setSelected(campaign);
      setGuidelineDraft(campaign.guideline_text || '');
      setStatusText('Campaign created. Parse the guideline to extract its rules.');
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
        body: JSON.stringify({ ...selected, guideline_text: guidelineDraft }),
      });
      setSelected(updated);
      setGuidelineDraft(updated.guideline_text || '');
      await refresh();
      setStatusText('Campaign saved.');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not save the campaign.');
    } finally {
      setBusy('');
    }
  };

  const parseGuideline = async () => {
    if (!selected) return;
    setBusy('parse');
    setError('');
    try {
      const updated = await apiJson(`/api/campaigns/${encodeURIComponent(selected.id)}/parse-guideline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...geminiHeaders() },
        body: JSON.stringify({ guideline_text: guidelineDraft }),
      });
      setSelected(updated);
      await refresh();
      const count = (updated.rules || []).length;
      setStatusText(count ? `Extracted ${count} rule(s) from the guideline.` : 'The AI returned no rules; refine the guideline text.');
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not parse the guideline.');
    } finally {
      setBusy('');
    }
  };

  const uploadAsset = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!selected || !file) return;
    const kind = window.prompt('Asset kind — type footage, logo, or other:', 'footage');
    if (!kind) return;
    const note = window.prompt('Usage note (optional):', '') || '';
    setBusy('upload');
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('kind', kind.trim().toLowerCase());
      form.append('note', note);
      const updated = await sendForm(`/api/campaigns/${encodeURIComponent(selected.id)}/assets`, form);
      setSelected(updated);
      await refresh();
      setStatusText(`Asset added: ${file.name}`);
    } catch (e) {
      setError(e?.detail || e?.message || 'Could not upload the asset.');
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
    <div className="p-4 sm:p-6 space-y-4 pb-20 md:pb-6">
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

      {error && <div className="card p-3 text-sm text-warn flex items-start gap-2"><Alert /><span>{error}</span></div>}
      {statusText && <div className="text-xs text-muted">{statusText}</div>}

      {creating && (
        <form onSubmit={createCampaign} className="card p-4 sm:p-5 grid sm:grid-cols-2 gap-3">
          <label className="block text-xs text-muted sm:col-span-2">Campaign name<input required value={newForm.name} onChange={(e) => setNewForm({ ...newForm, name: e.target.value })} maxLength={120} className="input mt-1 w-full" placeholder="Clippo — October fitness brief" /></label>
          <label className="block text-xs text-muted">Platform<input value={newForm.platform} onChange={(e) => setNewForm({ ...newForm, platform: e.target.value })} maxLength={200} className="input mt-1 w-full" placeholder="contentrewards / clippo.id" /></label>
          <label className="block text-xs text-muted">Reward<input value={newForm.reward} onChange={(e) => setNewForm({ ...newForm, reward: e.target.value })} maxLength={200} className="input mt-1 w-full" placeholder="$100 per accepted clip" /></label>
          <label className="block text-xs text-muted">Deadline<input value={newForm.deadline} onChange={(e) => setNewForm({ ...newForm, deadline: e.target.value })} maxLength={200} className="input mt-1 w-full" placeholder="2026-10-31" /></label>
          <label className="block text-xs text-muted">Brief link<input value={newForm.brief_link} onChange={(e) => setNewForm({ ...newForm, brief_link: e.target.value })} maxLength={500} className="input mt-1 w-full" placeholder="https://…" /></label>
          <label className="block text-xs text-muted sm:col-span-2">Guideline (paste now or later)<textarea value={newForm.guideline_text} onChange={(e) => setNewForm({ ...newForm, guideline_text: e.target.value })} maxLength={50000} rows={4} className="input mt-1 w-full resize-y" /></label>
          <div className="sm:col-span-2 flex gap-2 justify-end">
            <button type="button" onClick={() => setCreating(false)} className="btn-quiet px-3 py-2 text-sm">Cancel</button>
            <button type="submit" disabled={busy === 'create'} className="btn-primary px-3 py-2 text-sm disabled:opacity-50">{busy === 'create' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}Create campaign</button>
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
          <div className="card p-4 sm:p-5">
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

          <div className="card p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <div><p className="eyebrow">GUIDELINE &amp; RULES</p>
                <h3 className="text-sm text-ink font-medium mt-1">AI-extracted, reusable checks</h3></div>
            </div>
            <textarea value={guidelineDraft} onChange={(e) => setGuidelineDraft(e.target.value)} maxLength={50000} rows={6} placeholder="Paste the campaign guideline here…" className="input mt-3 w-full resize-y font-mono text-xs" />
            <div className="flex flex-wrap gap-2 mt-3">
              <button type="button" onClick={saveMeta} disabled={busy === 'save'} className="btn-quiet px-3 py-2 text-xs disabled:opacity-50"><Save size={13} />Save guideline</button>
              <button type="button" onClick={parseGuideline} disabled={busy === 'parse' || !guidelineDraft.trim()} className="btn-primary px-3 py-2 text-xs disabled:opacity-50">{busy === 'parse' ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}Extract rules with AI</button>
            </div>
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

          <div className="card p-4 sm:p-5">
            <p className="eyebrow">ASSETS</p>
            <h3 className="text-sm text-ink font-medium mt-1">Footage, logos and usage notes</h3>
            <label className="btn-quiet px-3 py-2 text-xs inline-flex items-center gap-2 mt-3 cursor-pointer">
              {busy === 'upload' ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}Upload asset
              <input type="file" className="hidden" onChange={uploadAsset} />
            </label>
            {(selected.assets || []).length > 0 && (
              <ul className="mt-3 space-y-2">
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

          <div className="card p-4 sm:p-5">
            <p className="eyebrow">DRAFT ANALYSES</p>
            <h3 className="text-sm text-ink font-medium mt-1">Drafts made from this campaign</h3>
            {(selected.drafts || []).length === 0
              ? <p className="text-xs text-muted mt-2">None yet — start a new analysis above.</p>
              : (
                <ul className="mt-3 space-y-2">
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
  );
}

function Alert() {
  return <span className="text-warn mt-0.5">⚠</span>;
}
