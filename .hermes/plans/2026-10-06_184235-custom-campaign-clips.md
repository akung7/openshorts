# Custom Campaign Clips Implementation Plan

> **For Hermes:** Execute task-by-task with test-driven-development. Preserve the existing Clip Generator as a separate legacy workflow.

**Goal:** Add a separate Custom Clips menu where users provide a campaign brief, discuss AI-proposed clip candidates, and explicitly approve a draft before any rendering starts.

**Architecture:** Keep `dashboard` / `POST /api/process` behavior unchanged. Add a custom workflow with persisted draft state and explicit analyze → discuss/edit draft → approve → render phases; only the server-stored approved plan may be rendered. Reuse OpenShorts transcription and lower-level cut/reframe/caption services where possible, without invoking normal automatic moment selection after approval.

**Tech Stack:** FastAPI/Python worker, existing Gemini/local LLM utilities, React/Vite dashboard, FFmpeg renderer, pytest and dashboard build/lint.

---

## Current repository context

- Frontend navigation is centralized in `dashboard/src/App.jsx` (`navItems`, `activeTab`, dashboard views).
- The existing input form is `dashboard/src/components/MediaInput.jsx`.
- `App.jsx:handleProcess` sends a combined job to `POST /api/process`.
- `app.py:process_endpoint` validates source/rights/options, creates a job, and queues `main.py`.
- `main.py` currently transcribes, selects moments (`get_viral_clips`), and renders in one run. A custom draft must therefore use a distinct staged path; calling `/api/process` before approval would violate the requirement.
- Existing render stages live in `main.py` and `reframe_v2.py`; per-clip state is recorded in metadata.
- Current git base was clean at `1578425`; implementation branch is `feat/custom-campaign-clips`.

## Campaign brief provided by the user

The six-page PDF is a Jonathan Crawford / Crawford Legacy Group campaign guide. Turn its requirements into explicit draft-plan checks:

**Hard/near-hard checks for each clip**
- Target TikTok and Instagram Reels; vertical 9:16.
- Aim for 15–45 seconds; allow a documented exception where a complete idea needs a different length.
- Earn attention in the first two seconds; don't open on a logo, black frame, or slow setup.
- Keep Jonathan's spoken meaning and context accurate. Never invent/alter quotes or add trading, income, get-rich, political, religious, or medical claims that are absent from the source.
- Captions should be bold/readable and remain inside platform-safe areas; keep the speaker's voice clear and dominant.
- Reject low-resolution reposts, copied edits, screen recordings, and watermarked source material.
- Do not produce duplicate edits/hooks/captions for distinct campaign posts.

**Ranking preferences, not absolute constraints**
- Favor the campaign pillars: talking head, hot take, lifestyle overlay, story cut, audio edit, and aura.
- Prefer edits that improve retention/recognition; complexity is optional.
- US audience; prefer US English copy and make Jonathan/name/role clear early.

**Out-of-scope campaign operations**
- Account handle, profile picture, bio, approved link-in-bio, US posting windows/cadence, 30-day public retention, comment replies, and performance tracking are not clip rendering. Show these in a campaign checklist only if useful; do not block rendering on items that cannot be verified from the video.
- Do not auto-publish in the MVP. The user approves clips for generation only.

The AI must distinguish `pass`, `warning`, and `needs user review`, provide supporting transcript/time evidence, and never claim compliance it cannot verify.

## Proposed workflow / acceptance criteria

1. **Separate entry point:** Add `Custom Clips` to the same shared sidebar/mobile navigation. The existing `Clip Generator` remains intact and continues to use its current endpoint.
2. **Campaign inputs:** Accept video upload or supported source URL, plus a campaign guideline PDF/text/Markdown upload or a public URL. Extract guideline text safely; validate URL fetch targets against SSRF (reuse existing validation). If a provider link requires login, ask the user to upload/export the brief instead of bypassing authentication.
3. **Analyze-only draft:** Create a durable custom draft id, extract/reuse a transcript, apply the guideline in the AI selection prompt, and return timestamped clip proposals with exact source evidence, proposed hook/caption, pillar, duration, platform/layout hints, rule-by-rule status, and reasons. No FFmpeg render, publishing, or irreversible action may run in this stage.
4. **Discussion:** Provide a chat tied to the draft. AI can revise or reject proposals and explain tradeoffs. Any draft mutation increments a revision and invalidates earlier approval. Chat must not enqueue the render job.
5. **Explicit approval:** Let the user select proposals and approve the exact displayed revision. Server-side approval is bound to a revision/hash; stale or unapproved plans are rejected.
6. **Generate approved clips:** Only the approval endpoint may enqueue rendering. It renders the server-stored approved time ranges and must not ask the normal moment selector to replace them. Reuse cut/reframe/caption stages where possible.
7. **Ownership and cleanup:** Custom draft, transcript, and guideline artifacts use existing job ownership/retention protections; never return another account's draft. Avoid storing campaign source material indefinitely.
8. **UI recovery:** Surface status/errors for queued analysis, draft ready, discussion updates, rendering, completion, and cancellation/retry as supported by current job patterns.

## Implementation tasks (TDD, vertical slices)

### Task 1 — Campaign checks and document extraction
- Inspect installed PDF/document dependencies and `security_utils.assert_public_url` / existing download helpers.
- Add a small custom-campaign module that normalizes guideline text and validates the draft's clip fields and campaign flags.
- Write failing tests for 9:16 / 15–45 guidance, exceptions, unsupported claims, missing transcript evidence, and safe guideline URL handling.
- Implement minimum helpers; keep campaign text input data-driven rather than hard-coding this example as the only campaign.

### Task 2 — Persisted draft state and analyze-only endpoint
- Add a custom draft record/file format with id, owner, source, extracted guideline, transcript, structured proposals, revision, and state.
- Write endpoint tests proving draft creation returns proposals and does not spawn a render process.
- Add analysis orchestration using the existing transcription/LLM helpers, emitting schema-validated proposals.
- Add ownership, malformed payload, missing guideline/source, and cleanup/error-path tests.

### Task 3 — Draft discussion and approval gate
- Add chat/update endpoint constrained to the stored draft context and JSON schema.
- Write tests that discussion only updates the draft, invalidates a previous approval on revision changes, and cannot enqueue rendering.
- Add approval tests: only selected candidates from the current revision can be approved; stale revision and no-selection requests are rejected.

### Task 4 — Render only approved time ranges
- Add an explicit custom-render command/input for approved clip intervals to the worker; don't alter the legacy command defaults.
- Test that the custom worker uses the supplied intervals and never calls automatic clip selection; test legacy CLI path is unchanged.
- Reuse existing FFmpeg cut, render, captions, and metadata behavior for approved intervals.

### Task 5 — Custom Clips UI
- Add a new page/component and navigation item for desktop rail, mobile drawer, and mobile tab-bar overflow.
- Inputs: source video/link, guide file/link, Analyze button. Draft view: transcript-backed proposal cards, campaign checks, chat, selection controls, explicit Approve & Generate button.
- Tests or component-level checks for state flow if test infrastructure exists; otherwise verify dashboard build/lint and manually drive local UI/API.
- Ensure the legacy screen is still the default and its form submits the same endpoint/payload.

### Task 6 — End-to-end verification and docs
- Run focused backend tests, full feasible pytest suite, `dashboard` build and lint.
- Verify analyze and chat produce zero render processes; verify only explicit approval enqueues the approved plan.
- Verify existing `/api/process` tests and payload contract remain unchanged.
- Document custom draft lifecycle, accepted guideline formats, privacy/retention, and approval semantics.

## Risks / trade-offs

- Separating analysis from rendering requires preserving source/transcript/plan between phases; state must survive worker restarts or fail clearly rather than silently rerunning generation.
- Link fetching can create SSRF risk; use existing URL validation, restrict response size/content type, and do not fetch authenticated pages with user cookies.
- AI cannot reliably verify source-video resolution, copied-edit provenance, actual platform-safe placement, or future posting behavior from transcript alone. Mark these as review-required unless a measurable check exists.
- The guide's 15–45 second recommendation says "unless the idea clearly needs more or less"; treat it as a target plus explanation, not an absolute backend rejection.
- Custom-generated hook copy must remain faithful to source; show source evidence and make the user the final reviewer.

## Verification commands

```bash
pytest tests/test_custom_campaign*.py -q
pytest tests/ -q
cd dashboard && npm run build && npm run lint
```

Inspect `git diff` and confirm no changes to legacy flow beyond additive routing/worker support before marking complete.
