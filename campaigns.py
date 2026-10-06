"""Campaign workspace storage for content-rewards clipper workflows.

A Campaign is the long-lived container the per-analysis drafts hang off of:
platform + reward + deadline metadata, AI-parsed structured rules, reusable
assets (footage / logo / notes), and the ids of the draft analyses made from
it. Storage mirrors the custom drafts: one JSON document per campaign inside
``output/campaigns/<uuid>/``.

Like custom_campaign.py, this module knows nothing about HTTP so every
validation rule is unit-testable without a server.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from pathlib import PurePath
from typing import Any

OUTPUT_ROOT = os.environ.get("OUTPUT_DIR", "output")
CAMPAIGNS_DIR = os.path.join(OUTPUT_ROOT, "campaigns")

MAX_NAME = 120
MAX_SHORT_TEXT = 200
MAX_NOTE = 1000
MAX_GUIDELINE_CHARS = 200_000
MAX_RULES = 40
MAX_ASSETS = 50
ASSET_KINDS = ("footage", "logo", "other")


class CampaignValidationError(ValueError):
    """Raised when a caller tries to persist an invalid campaign change."""


class CampaignNotFoundError(KeyError):
    """Raised when a campaign id does not exist on disk."""


def _now() -> float:
    return time.time()


def _clean_text(value: Any, limit: int, *, field: str, required: bool = False) -> str:
    text = str(value or "").strip()
    if not text:
        if required:
            raise CampaignValidationError(f"Campaign {field} is required")
        return ""
    if len(text) > limit:
        raise CampaignValidationError(f"Campaign {field} is too long (max {limit} characters)")
    return text


def _validate_brief_link(value: Any) -> str:
    link = _clean_text(value, 500, field="brief link")
    if link and not re.match(r"^https?://", link, re.IGNORECASE):
        raise CampaignValidationError("Campaign brief link must be an http(s) URL")
    return link


def normalize_rules(rules: Any) -> list[dict[str, str]]:
    """Validate an AI-parsed or hand-edited rules list into the stored shape."""
    if not isinstance(rules, list):
        raise CampaignValidationError("Campaign rules must be a list")
    if len(rules) > MAX_RULES:
        raise CampaignValidationError(f"A campaign can hold at most {MAX_RULES} rules")
    normalized: list[dict[str, str]] = []
    for item in rules:
        if not isinstance(item, dict):
            raise CampaignValidationError("Campaign rules must be objects")
        label = _clean_text(item.get("label"), MAX_SHORT_TEXT, field="rule label", required=True)
        normalized.append({
            "id": str(item.get("id") or uuid.uuid4()),
            "label": label,
            "description": _clean_text(item.get("description"), MAX_NOTE, field="rule description"),
        })
    return normalized


def create_campaign(
    *,
    name: Any,
    platform: Any = "",
    reward: Any = "",
    deadline: Any = "",
    brief_link: Any = "",
    guideline_text: Any = "",
    guideline_url: Any = "",
) -> dict[str, Any]:
    """Build the in-memory campaign document (not yet persisted)."""
    now = _now()
    return {
        "id": str(uuid.uuid4()),
        "name": _clean_text(name, MAX_NAME, field="name", required=True),
        "platform": _clean_text(platform, MAX_SHORT_TEXT, field="platform"),
        "reward": _clean_text(reward, MAX_SHORT_TEXT, field="reward"),
        "deadline": _clean_text(deadline, MAX_SHORT_TEXT, field="deadline"),
        "brief_link": _validate_brief_link(brief_link),
        "guideline_text": _clean_text(guideline_text, MAX_GUIDELINE_CHARS, field="guideline"),
        "guideline_url": _validate_brief_link(guideline_url),
        "rules": [],
        "assets": [],
        "drafts": [],
        "created_at": now,
        "updated_at": now,
    }


def campaign_dir(campaign_id: str) -> str:
    try:
        canonical = str(uuid.UUID(campaign_id))
    except (TypeError, ValueError, AttributeError):
        raise CampaignNotFoundError(campaign_id) from None
    return os.path.join(CAMPAIGNS_DIR, canonical)


def load_campaign(campaign_id: str) -> tuple[str, dict[str, Any]]:
    directory = campaign_dir(campaign_id)
    path = os.path.join(directory, "campaign.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            campaign = json.load(handle)
    except FileNotFoundError:
        raise CampaignNotFoundError(campaign_id) from None
    except (OSError, json.JSONDecodeError):
        raise CampaignValidationError("Could not read the saved campaign") from None
    if not isinstance(campaign, dict) or campaign.get("id") != os.path.basename(directory):
        raise CampaignNotFoundError(campaign_id)
    return directory, campaign


def save_campaign(directory: str, campaign: dict[str, Any]) -> None:
    campaign["updated_at"] = _now()
    path = os.path.join(directory, "campaign.json")
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(campaign, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def list_campaigns() -> list[dict[str, Any]]:
    """All campaigns, newest first, with the bulky guideline text stripped."""
    campaigns: list[dict[str, Any]] = []
    if not os.path.isdir(CAMPAIGNS_DIR):
        return campaigns
    for entry in os.listdir(CAMPAIGNS_DIR):
        path = os.path.join(CAMPAIGNS_DIR, entry, "campaign.json")
        try:
            with open(path, "r", encoding="utf-8") as handle:
                campaign = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(campaign, dict) and campaign.get("id") == entry:
            summary = {key: value for key, value in campaign.items() if key != "guideline_text"}
            campaigns.append(summary)
    campaigns.sort(key=lambda item: item.get("updated_at", 0), reverse=True)
    return campaigns


META_FIELDS = ("name", "platform", "reward", "deadline")


def revise_campaign(campaign: dict[str, Any], changes: dict[str, Any]) -> dict[str, Any]:
    """Apply an allow-listed metadata edit and bump updated_at."""
    if not isinstance(campaign, dict) or not campaign.get("id"):
        raise CampaignValidationError("Campaign is invalid")
    if not isinstance(changes, dict):
        raise CampaignValidationError("Campaign changes must be an object")
    for key in META_FIELDS:
        if key not in changes:
            continue
        campaign[key] = _clean_text(changes[key], MAX_NAME if key == "name" else MAX_SHORT_TEXT, field=key, required=key == "name")
    if "brief_link" in changes:
        campaign["brief_link"] = _validate_brief_link(changes["brief_link"])
    if "guideline_text" in changes:
        campaign["guideline_text"] = _clean_text(changes["guideline_text"], MAX_GUIDELINE_CHARS, field="guideline")
    if "guideline_url" in changes:
        campaign["guideline_url"] = _validate_brief_link(changes["guideline_url"])
    if changes.get("rules") is not None:
        campaign["rules"] = normalize_rules(changes["rules"])
    return campaign


def set_rules(campaign: dict[str, Any], rules: Any) -> dict[str, Any]:
    campaign["rules"] = normalize_rules(rules)
    return campaign


def add_asset(
    campaign: dict[str, Any],
    *,
    asset_id: str,
    kind: Any,
    filename: Any,
    note: Any = "",
) -> dict[str, Any]:
    if len(campaign.get("assets", [])) >= MAX_ASSETS:
        raise CampaignValidationError(f"A campaign can hold at most {MAX_ASSETS} assets")
    asset_kind = str(kind or "other").strip().lower()
    if asset_kind not in ASSET_KINDS:
        raise CampaignValidationError("Asset kind must be footage, logo, or other")
    safe_name = os.path.basename(str(filename or "").replace("\\", "/"))
    if not safe_name or safe_name in (".", ".."):
        raise CampaignValidationError("Asset filename is invalid")
    if len(safe_name) > 255:
        raise CampaignValidationError("Asset filename is too long")
    asset = {
        "id": str(asset_id or uuid.uuid4()),
        "kind": asset_kind,
        "filename": safe_name,
        "note": _clean_text(note, MAX_NOTE, field="asset note"),
        "added_at": _now(),
    }
    if any(existing.get("id") == asset["id"] for existing in campaign.get("assets", [])):
        raise CampaignValidationError("Asset id already exists in this campaign")
    campaign.setdefault("assets", []).append(asset)
    return asset


def remove_asset(campaign: dict[str, Any], asset_id: str) -> dict[str, Any]:
    assets = campaign.get("assets", [])
    for index, asset in enumerate(assets):
        if asset.get("id") == asset_id:
            return assets.pop(index)
    raise CampaignValidationError("Asset not found in this campaign")


def attach_draft(campaign: dict[str, Any], draft_id: str) -> None:
    draft_id = str(draft_id)
    if draft_id not in campaign.setdefault("drafts", []):
        campaign["drafts"].append(draft_id)


def asset_path(directory: str, asset: dict[str, Any]) -> str:
    """Resolve an asset's on-disk location, refusing to escape the campaign dir."""
    candidate = os.path.realpath(os.path.join(directory, "assets", asset["filename"]))
    root = os.path.realpath(os.path.join(directory, "assets")) + os.sep
    if not candidate.startswith(root):
        raise CampaignValidationError("Asset path escapes the campaign directory")
    return candidate


def delete_campaign(directory: str) -> None:
    shutil.rmtree(directory, ignore_errors=True)


def rules_prompt_block(campaign: dict[str, Any]) -> str:
    """Render the stored rules as authoritative text for the analysis prompt."""
    rules = campaign.get("rules") or []
    if not rules:
        return ""
    lines = ["MANDATORY CAMPAIGN RULES (violating candidates must be flagged):"]
    for index, rule in enumerate(rules, start=1):
        line = f"{index}. {rule.get('label', '')}"
        description = str(rule.get("description") or "").strip()
        if description:
            line += f" — {description}"
        lines.append(line)
    return "\n".join(lines)


def summary_view(campaign: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in campaign.items() if key != "guideline_text"}


def public_view(campaign: dict[str, Any]) -> dict[str, Any]:
    """Everything the owner may see; keep a shallow copy to protect the store."""
    return json.loads(json.dumps(campaign))


def safe_filename(filename: Any) -> str:
    """Last path component on every OS, so '..\\evil.mp4' cannot escape."""
    return os.path.basename(str(filename or "").replace("\\", "/"))
