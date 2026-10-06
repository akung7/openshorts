import pytest

from custom_campaign import (
    DraftValidationError,
    StaleDraftError,
    approve_draft,
    revise_draft,
)


def _draft():
    return {
        "id": "draft-1",
        "revision": 2,
        "status": "draft",
        "clips": [
            {"id": "clip-a", "start": 4.0, "end": 28.0},
            {"id": "clip-b", "start": 50.0, "end": 83.0},
        ],
    }


def test_approval_binds_selected_clips_to_current_revision():
    approved = approve_draft(_draft(), revision=2, selected_clip_ids=["clip-b"])

    assert approved["status"] == "approved"
    assert approved["approved_revision"] == 2
    assert [clip["id"] for clip in approved["approved_clips"]] == ["clip-b"]


def test_approval_rejects_stale_revision():
    with pytest.raises(StaleDraftError):
        approve_draft(_draft(), revision=1, selected_clip_ids=["clip-a"])


def test_approval_rejects_unknown_or_empty_selection():
    with pytest.raises(DraftValidationError):
        approve_draft(_draft(), revision=2, selected_clip_ids=[])
    with pytest.raises(DraftValidationError):
        approve_draft(_draft(), revision=2, selected_clip_ids=["not-in-draft"])


def test_revision_invalidates_previous_approval_and_increments_revision():
    draft = approve_draft(_draft(), revision=2, selected_clip_ids=["clip-a"])

    revised = revise_draft(draft, {"summary": "Updated after discussion"})

    assert revised["revision"] == 3
    assert revised["status"] == "draft"
    assert "approved_revision" not in revised
    assert "approved_clips" not in revised


def test_cannot_revise_a_rendering_or_completed_draft():
    draft = _draft()
    draft["status"] = "rendering"

    with pytest.raises(DraftValidationError):
        revise_draft(draft, {"summary": "late mutation"})


def test_extract_guideline_text_from_utf8_file():
    from custom_campaign import extract_guideline_text

    text = extract_guideline_text("campaign.md", b"Use 9:16 and captions in US English")

    assert "9:16" in text
    assert "US English" in text


def test_extract_guideline_text_from_pdf(tmp_path):
    import pymupdf
    from custom_campaign import extract_guideline_text

    path = tmp_path / "guide.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Use a strong hook in the first two seconds")
    doc.save(path)

    text = extract_guideline_text("guide.pdf", path.read_bytes())

    assert "strong hook" in text


def test_reject_unsupported_or_empty_guideline_upload():
    from custom_campaign import extract_guideline_text

    with pytest.raises(DraftValidationError, match="supported"):
        extract_guideline_text("guide.exe", b"not a guide")
    with pytest.raises(DraftValidationError, match="empty"):
        extract_guideline_text("guide.txt", b"  ")


def test_campaign_prompt_uses_runtime_guideline_and_timed_transcript():
    from custom_campaign import build_campaign_prompt

    prompt = build_campaign_prompt(
        {"language": "en", "segments": [{"start": 1.2, "end": 3.8, "text": "This is the source quote."}]},
        90,
        "Use 9:16; do not add unsupported income claims.",
    )

    assert "Use 9:16" in prompt
    assert "unsupported income claims" in prompt
    assert "1.2" in prompt and "3.8" in prompt
    assert "This is the source quote." in prompt


def test_normalize_campaign_response_flags_duration_exception_and_missing_evidence():
    from custom_campaign import normalize_campaign_response

    result = normalize_campaign_response(
        {
            "summary": "One candidate needs review.",
            "campaign_rules": [{"id": "hook", "label": "Fast hook", "status": "pass", "reason": "Good opening", "evidence": ""}],
            "clips": [{
                "start": 10, "end": 62, "title": "Story", "hook": "Listen up",
                "caption": "A source-grounded caption", "pillar": "story cut",
                "evidence": "This is supported", "checks": [],
            }],
        },
        video_duration=120,
    )

    assert result["campaign_rules"][0]["status"] == "review"
    assert result["clips"][0]["duration"] == 52
    assert any(check["rule_id"] == "duration" and check["status"] == "warning" for check in result["clips"][0]["checks"])


def test_normalize_campaign_response_rejects_invalid_time_ranges():
    from custom_campaign import normalize_campaign_response

    with pytest.raises(DraftValidationError, match="timestamps"):
        normalize_campaign_response({"clips": [{"start": 30, "end": 10}]}, video_duration=60)


def test_campaign_evidence_must_match_source_transcript():
    from custom_campaign import normalize_campaign_response

    normalized = normalize_campaign_response(
        {
            "summary": "Candidate",
            "campaign_rules": [{"id": "claim", "label": "Source claim", "status": "pass", "reason": "Verified", "evidence": "[2-4s] This quote is invented"}],
            "clips": [{"start": 2, "end": 22, "title": "Candidate", "hook": "Hook", "caption": "Caption", "evidence": "[2-4s] This quote is invented", "checks": [{"rule_id": "claim", "status": "pass", "reason": "Verified", "evidence": "[2-4s] This quote is invented"}]}],
        },
        video_duration=30,
        transcript={"segments": [{"start": 2, "end": 4, "text": "This is the real source statement."}]},
    )

    assert normalized["campaign_rules"][0]["status"] == "review"
    assert normalized["clips"][0]["checks"][0]["status"] == "review"
    assert any(check["rule_id"] == "source-evidence" for check in normalized["clips"][0]["checks"])


def test_clip_evidence_timestamp_must_fall_inside_candidate_range():
    from custom_campaign import normalize_campaign_response

    normalized = normalize_campaign_response(
        {"clips": [{
            "start": 2, "end": 22, "title": "Candidate", "hook": "Hook", "caption": "Caption",
            "evidence": "[25-29s] Exact source quote", "checks": [],
        }]},
        video_duration=30,
        transcript={"segments": [{"start": 25, "end": 29, "text": "Exact source quote"}]},
    )

    assert any(check["rule_id"] == "source-evidence" and check["status"] == "review" for check in normalized["clips"][0]["checks"])


def test_discussion_prompt_keeps_campaign_and_draft_context():
    from custom_campaign import build_campaign_chat_prompt

    prompt = build_campaign_chat_prompt(
        {"summary": "Candidate A", "transcript": {"language": "en", "segments": [{"start": 8, "end": 10, "text": "Original campaign quote"}]}, "clips": [{"id": "clip-a", "start": 12, "end": 32, "hook": "A quote"}]},
        "Keep this in the story cut pillar.",
        "Use 9:16 and no unsupported claims.",
    )

    assert "Keep this in the story cut pillar." in prompt
    assert "Use 9:16" in prompt
    assert "clip-a" in prompt
    assert "Original campaign quote" in prompt


def test_approved_plan_detects_mutation_after_approval():
    from custom_campaign import assert_approved_draft

    approved = approve_draft(_draft(), revision=2, selected_clip_ids=["clip-a"])
    assert assert_approved_draft(approved)[0]["id"] == "clip-a"

    approved["approved_clips"][0]["start"] = 999
    with pytest.raises(DraftValidationError, match="changed"):
        assert_approved_draft(approved)


def test_create_campaign_draft_persists_guideline_transcript_and_proposals():
    from custom_campaign import create_campaign_draft

    draft = create_campaign_draft(
        draft_id="draft-9",
        video_duration=90,
        transcript={"language": "en", "segments": [{"start": 5, "end": 8, "text": "Exact source quote"}]},
        guideline_text="Campaign must use vertical format.",
        source_video="interview.mp4",
        response={"summary": "One idea", "clips": [{
            "start": 5, "end": 29, "title": "The story", "hook": "Here is why",
            "caption": "Watch the full story", "pillar": "story cut",
            "evidence": "[5-8s] Exact source quote", "checks": [],
        }]},
    )

    assert draft["status"] == "draft"
    assert draft["revision"] == 1
    assert draft["guideline_text"] == "Campaign must use vertical format."
    assert draft["transcript"]["segments"][0]["text"] == "Exact source quote"
    assert draft["clips"][0]["start"] == 5
    assert draft["source_video"] == "interview.mp4"


def test_approved_render_plan_contains_only_frozen_approved_candidates():
    from custom_campaign import build_approved_render_plan

    draft = {
        "id": "draft-1", "revision": 1, "status": "draft", "video_duration": 90,
        "transcript": {"language": "en", "segments": []},
        "clips": [
            {"id": "clip-a", "start": 5, "end": 25, "title": "A", "hook": "Hook A", "caption": "Caption A", "evidence": "Quote A"},
            {"id": "clip-b", "start": 30, "end": 55, "title": "B", "hook": "Hook B", "caption": "Caption B", "evidence": "Quote B"},
        ],
    }
    approved = approve_draft(draft, revision=1, selected_clip_ids=["clip-b"])

    plan = build_approved_render_plan(approved)

    assert len(plan["clips"]) == 1
    assert plan["clips"][0]["start"] == 30
    assert plan["clips"][0]["end"] == 55
    assert plan["clips"][0]["video_title_for_youtube_short"] == "B"
    assert plan["transcript"] == {"language": "en", "segments": []}


def test_campaign_analysis_uses_configured_llm_and_runtime_guide(monkeypatch):
    import sys
    import types
    from custom_campaign import generate_campaign_analysis

    captured = {}
    response = {"summary": "Two source-backed ideas", "campaign_rules": [], "clips": []}
    backend = types.SimpleNamespace(
        active=lambda: True,
        model_name=lambda: "local-test-model",
        generate_json=lambda prompt, schema, model: captured.update(
            prompt=prompt, model=model, schema=schema
        ) or (response, None),
    )
    monkeypatch.setitem(sys.modules, "llm_backend", backend)
    monkeypatch.setitem(sys.modules, "pydantic", types.SimpleNamespace(
        BaseModel=object,
        Field=lambda default_factory=None, **kwargs: default_factory() if default_factory else kwargs.get("default"),
    ))

    result = generate_campaign_analysis(
        api_key=None,
        transcript={"language": "en", "segments": [{"start": 2, "end": 4, "text": "Grounded quote"}]},
        video_duration=60,
        guideline_text="Campaign-specific rule",
    )

    assert result == response
    assert captured["model"] == "local-test-model"
    assert "Campaign-specific rule" in captured["prompt"]
    assert "Grounded quote" in captured["prompt"]
    assert captured["schema"].__name__ == "CampaignResponse"


def test_campaign_analysis_can_override_the_configured_compatible_model(monkeypatch):
    import sys
    import types
    from custom_campaign import generate_campaign_analysis

    captured = {}
    response = {"summary": "Selected model draft", "campaign_rules": [], "clips": []}
    backend = types.SimpleNamespace(
        active=lambda: False,
        model_name=lambda: "server-default",
        base_url=lambda: "https://llm.test/v1",
        generate_json=lambda prompt, schema, model: captured.update(model=model) or (response, None),
    )
    monkeypatch.setitem(sys.modules, "llm_backend", backend)
    monkeypatch.setitem(sys.modules, "pydantic", types.SimpleNamespace(
        BaseModel=object,
        Field=lambda default_factory=None, **kwargs: default_factory() if default_factory else kwargs.get("default"),
    ))

    result = generate_campaign_analysis(
        api_key=None,
        transcript={"language": "en", "segments": []},
        video_duration=60,
        guideline_text="Campaign-specific rule",
        provider="openai-compatible",
        model="selected-model",
    )

    assert result == response
    assert captured["model"] == "selected-model"


def test_campaign_chat_reuses_the_draft_provider_and_model(monkeypatch):
    import sys
    import types
    from custom_campaign import generate_campaign_chat

    captured = {}
    response = {"reply": "Updated", "summary": "Revised", "campaign_rules": [], "clips": []}
    backend = types.SimpleNamespace(
        active=lambda: False,
        model_name=lambda: "server-default",
        base_url=lambda: "https://llm.test/v1",
        generate_json=lambda prompt, schema, model: captured.update(model=model) or (response, None),
    )
    monkeypatch.setitem(sys.modules, "llm_backend", backend)
    monkeypatch.setitem(sys.modules, "pydantic", types.SimpleNamespace(
        BaseModel=object,
        Field=lambda default_factory=None, **kwargs: default_factory() if default_factory else kwargs.get("default"),
    ))

    result = generate_campaign_chat(
        api_key=None,
        draft={"summary": "Draft", "clips": [], "campaign_rules": []},
        message="Make the hook shorter",
        guideline_text="Keep it concise",
        provider="openai-compatible",
        model="draft-selected-model",
    )

    assert result == response
    assert captured["model"] == "draft-selected-model"


def test_edit_draft_clips_updates_manual_fields_and_preserves_candidate_id():
    from custom_campaign import edit_draft_clips

    draft = {
        "id": "draft-1", "revision": 2, "status": "draft", "video_duration": 100,
        "clips": [{
            "id": "clip-1", "start": 10, "end": 30, "duration": 20,
            "title": "Old title", "hook": "Old hook", "caption": "Old caption",
            "pillar": "story", "evidence": "[12-15s] exact quote",
            "checks": [{"rule_id": "source-evidence", "status": "pass", "reason": "Supported", "evidence": "[12-15s] exact quote"}],
        }],
    }

    edited = edit_draft_clips(draft, revision=2, clips=[{
        "id": "clip-1", "start": 11, "end": 31, "title": "New title",
        "hook": "New hook", "caption": "New caption", "pillar": "story",
    }])

    clip = edited["clips"][0]
    assert edited["revision"] == 3
    assert clip["id"] == "clip-1"
    assert (clip["start"], clip["end"], clip["duration"]) == (11.0, 31.0, 20.0)
    assert (clip["title"], clip["hook"], clip["caption"]) == ("New title", "New hook", "New caption")
    assert clip["checks"][0]["status"] == "pass"
    assert any(check["rule_id"] == "user-copy-review" and check["status"] == "review" for check in clip["checks"])


def test_edit_draft_clips_adds_manual_candidate_and_marks_evidence_for_review():
    from custom_campaign import edit_draft_clips

    draft = {"id": "draft-1", "revision": 1, "status": "draft", "video_duration": 90, "clips": []}

    edited = edit_draft_clips(draft, revision=1, clips=[{
        "start": 5, "end": 20, "title": "Manual", "hook": "Hook", "caption": "Caption",
    }])

    clip = edited["clips"][0]
    assert clip["id"]
    assert clip["pillar"] == "Manual"
    assert clip["evidence"] == ""
    assert any(check["rule_id"] == "source-evidence" and check["status"] == "review" for check in clip["checks"])


def test_edit_draft_clips_rejects_invalid_or_stale_edits():
    import pytest
    from custom_campaign import DraftValidationError, StaleDraftError, edit_draft_clips

    draft = {"id": "draft-1", "revision": 1, "status": "draft", "video_duration": 30, "clips": []}
    clip = {"start": 1, "end": 10, "title": "Manual", "hook": "", "caption": ""}

    with pytest.raises(StaleDraftError):
        edit_draft_clips(draft, revision=0, clips=[clip])
    with pytest.raises(DraftValidationError):
        edit_draft_clips(draft, revision=1, clips=[{**clip, "end": 31}])
