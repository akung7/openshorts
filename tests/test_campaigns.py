"""Campaign workspace: storage rules, endpoints and analyze integration."""
import io
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as app_module
import custom_campaign
import campaigns


class CampaignStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(campaigns, "CAMPAIGNS_DIR", str(Path(self.tmp.name) / "campaigns"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_create_requires_name_and_validates_fields(self):
        with self.assertRaises(campaigns.CampaignValidationError):
            campaigns.create_campaign(name="   ")
        with self.assertRaises(campaigns.CampaignValidationError):
            campaigns.create_campaign(name="C", brief_link="ftp://nope")
        campaign = campaigns.create_campaign(name="Clippo - Oktober", platform="clippo.id", reward="Rp500k")
        self.assertTrue(uuid.UUID(campaign["id"]))
        self.assertEqual(campaign["rules"], [])
        self.assertEqual(campaign["assets"], [])

    def test_save_load_and_list_roundtrip(self):
        campaign = campaigns.create_campaign(name="Roundtrip", guideline_text="RULES")
        directory = campaigns.campaign_dir(campaign["id"])
        os.makedirs(directory)
        campaigns.save_campaign(directory, campaign)
        loaded_dir, loaded = campaigns.load_campaign(campaign["id"])
        self.assertEqual(loaded_dir, directory)
        self.assertEqual(loaded["name"], "Roundtrip")
        listed = campaigns.list_campaigns()
        self.assertEqual([item["id"] for item in listed], [campaign["id"]])
        self.assertNotIn("guideline_text", listed[0])

    def test_revise_is_allow_listed_and_validates(self):
        campaign = campaigns.create_campaign(name="A")
        campaigns.revise_campaign(campaign, {"name": "B", "brief_link": "https://x.id", "bogus": "dropped"})
        self.assertEqual(campaign["name"], "B")
        self.assertEqual(campaign["brief_link"], "https://x.id")
        self.assertNotIn("bogus", campaign)
        with self.assertRaises(campaigns.CampaignValidationError):
            campaigns.revise_campaign(campaign, {"name": ""})

    def test_rules_normalization_and_prompt_block(self):
        campaign = campaigns.create_campaign(name="R")
        campaigns.set_rules(campaign, [
            {"label": "Duration 30-60s", "description": "Final cut length"},
            {"id": "fixed-id", "label": "Hashtag #clippo", "description": ""},
        ])
        self.assertEqual([r["id"] for r in campaign["rules"]][1], "fixed-id")
        block = campaigns.rules_prompt_block(campaign)
        self.assertIn("MANDATORY CAMPAIGN RULES", block)
        self.assertIn("1. Duration 30-60s — Final cut length", block)
        self.assertIn("2. Hashtag #clippo", block)
        with self.assertRaises(campaigns.CampaignValidationError):
            campaigns.set_rules(campaign, [{"label": ""}])

    def test_assets_add_remove_and_path_containment(self):
        campaign = campaigns.create_campaign(name="Assets")
        campaigns.add_asset(campaign, asset_id="a1", kind="footage", filename="clip.mp4", note="b-roll")
        self.assertEqual(campaign["assets"][0]["kind"], "footage")
        with self.assertRaises(campaigns.CampaignValidationError):
            campaigns.add_asset(campaign, asset_id="a2", kind="meme", filename="x.mp4")
        with self.assertRaises(campaigns.CampaignValidationError):
            campaigns.add_asset(campaign, asset_id="a1", kind="logo", filename="logo.png")
        removed = campaigns.remove_asset(campaign, "a1")
        self.assertEqual(removed["filename"], "clip.mp4")
        with self.assertRaises(campaigns.CampaignValidationError):
            campaigns.remove_asset(campaign, "missing")
        campaigns.add_asset(campaign, asset_id="a3", kind="footage", filename="..\\evil.mp4")
        self.assertEqual(campaign["assets"][0]["filename"], "evil.mp4")

    def test_attach_draft_is_idempotent(self):
        campaign = campaigns.create_campaign(name="D")
        campaigns.attach_draft(campaign, "draft-1")
        campaigns.attach_draft(campaign, "draft-1")
        self.assertEqual(campaign["drafts"], ["draft-1"])


class CampaignEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for module, name, value in (
            (campaigns, "CAMPAIGNS_DIR", str(root / "campaigns")),
            (app_module, "OUTPUT_DIR", str(root / "output")),
            (app_module, "UPLOAD_DIR", str(root / "uploads")),
        ):
            patcher = patch.object(module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.client = TestClient(app_module.app, raise_server_exceptions=False)

    def test_campaign_crud_roundtrip(self):
        created = self.client.post("/api/campaigns", json={"name": "Clippo Oktober", "platform": "clippo.id"}).json()
        cid = created["id"]
        self.assertEqual(created["name"], "Clippo Oktober")
        self.assertIn("guideline_text", created)

        listed = self.client.get("/api/campaigns").json()["campaigns"]
        self.assertEqual([item["id"] for item in listed], [cid])
        self.assertNotIn("guideline_text", listed[0])

        fetched = self.client.get(f"/api/campaigns/{cid}").json()
        self.assertEqual(fetched["guideline_text"], "")

        updated = self.client.put(f"/api/campaigns/{cid}", json={
            "name": "Clippo Oktober", "reward": "Rp500.000",
            "brief_link": "https://clippo.id/brief", "guideline_text": "30-60s, hashtag #clippo",
        }).json()
        self.assertEqual(updated["reward"], "Rp500.000")
        self.assertIn("30-60s", updated["guideline_text"])

        status = self.client.delete(f"/api/campaigns/{cid}").status_code
        self.assertEqual(status, 200)
        self.assertEqual(self.client.get(f"/api/campaigns/{cid}").status_code, 404)
        self.assertEqual(self.client.get("/api/campaigns").json()["campaigns"], [])

    def test_create_validation_returns_422(self):
        response = self.client.post("/api/campaigns", json={"name": ""})
        self.assertEqual(response.status_code, 422)

    def test_parse_guideline_uses_resolved_key_and_saves_rules(self):
        created = self.client.post("/api/campaigns", json={"name": "Parse test"}).json()
        cid = created["id"]

        async def fake_key(_request):
            return "key-from-header"

        def fake_parse(text, *, api_key=None, model=None, provider="gemini"):
            self.assertEqual(api_key, "key-from-header")
            self.assertIn("mandatory", text.lower())
            return {"rules": [{"label": "Duration 30-60s", "description": "final cut"}]}

        with patch.object(app_module, "resolve_gemini", fake_key), \
             patch.object(app_module, "parse_campaign_guideline", fake_parse):
            response = self.client.post(f"/api/campaigns/{cid}/parse-guideline", json={"guideline_text": "Mandatory: 30-60 seconds."})
        self.assertEqual(response.status_code, 200, response.text)
        rules = response.json()["rules"]
        self.assertEqual(rules[0]["label"], "Duration 30-60s")

        # persisted
        refetched = self.client.get(f"/api/campaigns/{cid}").json()
        self.assertEqual(refetched["rules"][0]["label"], "Duration 30-60s")

    def test_asset_upload_and_delete_roundtrip(self):
        created = self.client.post("/api/campaigns", json={"name": "Assets"}).json()
        cid = created["id"]
        upload = self.client.post(
            f"/api/campaigns/{cid}/assets",
            files={"file": ("footage.mp4", io.BytesIO(b"0123456789"), "video/mp4")},
            data={"kind": "footage", "note": "main b-roll"},
        )
        self.assertEqual(upload.status_code, 200, upload.text)
        asset = upload.json()["assets"][0]
        self.assertEqual(asset["kind"], "footage")
        self.assertEqual(asset["note"], "main b-roll")
        _, campaign = campaigns.load_campaign(cid)
        path = campaigns.asset_path(campaigns.campaign_dir(cid), asset)
        self.assertTrue(os.path.isfile(path))

        removed = self.client.delete(f"/api/campaigns/{cid}/assets/{asset['id']}")
        self.assertEqual(removed.status_code, 200)
        self.assertEqual(removed.json()["assets"], [])
        self.assertFalse(os.path.exists(path))

    def test_unknown_campaign_returns_404(self):
        missing = str(uuid.uuid4())
        self.assertEqual(self.client.get(f"/api/campaigns/{missing}").status_code, 404)
        self.assertEqual(self.client.delete(f"/api/campaigns/{missing}/assets/x").status_code, 404)


class AnalyzeCampaignLinkTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        patchers = [
            patch.object(campaigns, "CAMPAIGNS_DIR", str(root / "campaigns")),
            patch.object(app_module, "OUTPUT_DIR", str(root / "output")),
            patch.object(app_module, "UPLOAD_DIR", str(root / "uploads")),
            patch.object(app_module, "_enqueue_job", lambda *a, **k: None),
            patch.object(app_module, "_write_resume_manifest", lambda *a, **k: None),
        ]
        async def fake_reserve(_request, _url, _input_path, _job_id):
            return None, 2, None, "byok", None
        patchers.append(patch.object(app_module, "reserve_process_minutes", fake_reserve))
        for patcher in patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        (root / "output").mkdir()
        (root / "uploads").mkdir()
        self.client = TestClient(app_module.app, raise_server_exceptions=False)

    def _analyze(self, campaign_id=None, guideline="Do the thing."):
        form = {
            "guideline_text": guideline,
            "acknowledged": "1",
            "ai_provider": "gemini",
        }
        if campaign_id:
            form["campaign_id"] = campaign_id
        files = {"file": ("src.mp4", io.BytesIO(b"0123456789"), "video/mp4")}
        with patch.object(app_module, "resolve_gemini", _fake_key):
            return self.client.post("/api/custom/analyze", data=form, files=files)

    def test_analyze_unknown_campaign_is_404(self):
        response = self._analyze(campaign_id=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 404, response.text)

    def test_analyze_injects_campaign_rules_and_links_draft(self):
        created = self.client.post("/api/campaigns", json={
            "name": "Linked", "guideline_text": "Be funny.",
        }).json()
        cid = created["id"]
        _, campaign = campaigns.load_campaign(cid)
        campaigns.set_rules(campaign, [{"label": "Duration 30-60s", "description": "final cut"}])
        campaigns.save_campaign(campaigns.campaign_dir(cid), campaign)

        response = self._analyze(campaign_id=cid, guideline="")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["campaign_id"], cid)

        draft_id = response.json()["draft_id"]
        _, after = campaigns.load_campaign(cid)
        self.assertIn(draft_id, after["drafts"])
        written = (Path(self.tmp.name) / "output" / draft_id / "campaign_guideline.txt").read_text(encoding="utf-8")
        self.assertIn("MANDATORY CAMPAIGN RULES", written)
        self.assertIn("Duration 30-60s", written)

    def test_analyze_without_campaign_keeps_empty_campaign_id(self):
        response = self._analyze()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["campaign_id"])


async def _fake_key(_request):
    return "key"


if __name__ == "__main__":
    unittest.main()


class CampaignUrlIngestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        patcher = patch.object(campaigns, "CAMPAIGNS_DIR", str(root / "campaigns"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(app_module.app, raise_server_exceptions=False)

    def test_parse_guideline_from_public_url(self):
        created = self.client.post("/api/campaigns", json={"name": "URL brief"}).json()
        cid = created["id"]

        def fake_fetch(url):
            self.assertEqual(url, "https://example.com/brief.pdf")
            return "Mandatory: 30-60 seconds, hashtag #clippo."

        async def fake_key(_request):
            return "key"

        def fake_parse(text, *, api_key=None, model=None, provider="gemini"):
            self.assertIn("30-60", text)
            return {"rules": [{"label": "Duration 30-60s", "description": ""}]}

        with patch.object(app_module, "fetch_guideline_text", fake_fetch), \
             patch.object(app_module, "resolve_gemini", fake_key), \
             patch.object(app_module, "parse_campaign_guideline", fake_parse):
            response = self.client.post(
                f"/api/campaigns/{cid}/parse-guideline",
                json={"guideline_url": "https://example.com/brief.pdf"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["rules"][0]["label"], "Duration 30-60s")
        self.assertEqual(body["guideline_text"], "Mandatory: 30-60 seconds, hashtag #clippo.")
        self.assertEqual(body["guideline_url"], "https://example.com/brief.pdf")

    def test_asset_from_url_downloads_and_registers(self):
        created = self.client.post("/api/campaigns", json={"name": "URL assets"}).json()
        cid = created["id"]

        async def fake_download(url, assets_dir, *, max_bytes):
            self.assertTrue(assets_dir.endswith(os.path.join("assets")))
            stored = "stored-clip.mp4"
            with open(os.path.join(assets_dir, stored), "wb") as handle:
                handle.write(b"videobytes")
            return stored

        with patch.object(app_module, "_download_asset_from_url", fake_download):
            response = self.client.post(
                f"/api/campaigns/{cid}/assets-from-url",
                json={"url": "https://example.com/clip.mp4", "kind": "footage", "note": "drone shot"},
            )
        self.assertEqual(response.status_code, 200, response.text)
        asset = response.json()["assets"][0]
        self.assertEqual(asset["kind"], "footage")
        self.assertEqual(asset["note"], "drone shot")
        path = campaigns.asset_path(campaigns.campaign_dir(cid), asset)
        self.assertTrue(os.path.isfile(path))
        self.assertEqual(Path(path).read_bytes(), b"videobytes")

    def test_asset_from_url_rejects_bad_kind_and_cleans_up(self):
        created = self.client.post("/api/campaigns", json={"name": "Bad kind"}).json()
        cid = created["id"]

        async def fake_download(url, assets_dir, *, max_bytes):
            stored = "x.bin"
            with open(os.path.join(assets_dir, stored), "wb") as handle:
                handle.write(b"x")
            return stored

        with patch.object(app_module, "_download_asset_from_url", fake_download):
            response = self.client.post(
                f"/api/campaigns/{cid}/assets-from-url",
                json={"url": "https://example.com/x.bin", "kind": "meme"},
            )
        self.assertEqual(response.status_code, 422)
        _, campaign = campaigns.load_campaign(cid)
        self.assertEqual(campaign["assets"], [])
        self.assertFalse(os.path.exists(os.path.join(campaigns.campaign_dir(cid), "assets", "x.bin")))


class GuidelineIngestExtraTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(campaigns, "CAMPAIGNS_DIR", str(Path(self.tmp.name) / "campaigns"))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(app_module.app, raise_server_exceptions=False)

    def test_normalize_drive_url(self):
        self.assertEqual(
            custom_campaign.normalize_drive_url("https://drive.google.com/file/d/1AbC/view?usp=drive_link"),
            "https://drive.google.com/uc?export=download&id=1AbC",
        )
        self.assertEqual(
            custom_campaign.normalize_drive_url("https://example.com/plain.pdf"),
            "https://example.com/plain.pdf",
        )

    def test_parse_guideline_file_uploads_and_extracts(self):
        created = self.client.post("/api/campaigns", json={"name": "File brief"}).json()
        cid = created["id"]

        def fake_extract(filename, content):
            self.assertTrue(filename.endswith(".pdf"))
            return "Mandatory: 30-60 seconds."

        async def fake_key(_request):
            return "key"

        def fake_parse(text, *, api_key=None, model=None, provider="gemini"):
            return {"rules": [{"label": "Duration 30-60s", "description": ""}]}

        with patch.object(app_module, "extract_guideline_text", fake_extract), \
             patch.object(app_module, "resolve_gemini", fake_key), \
             patch.object(app_module, "parse_campaign_guideline", fake_parse):
            response = self.client.post(
                f"/api/campaigns/{cid}/parse-guideline-file",
                files={"file": ("brief.pdf", b"%PDF-fake", "application/pdf")},
            )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["rules"][0]["label"], "Duration 30-60s")
        self.assertIn("30-60", body["guideline_text"])

    def test_parse_guideline_file_rejects_empty_extract(self):
        created = self.client.post("/api/campaigns", json={"name": "Empty"}).json()
        cid = created["id"]
        with patch.object(app_module, "extract_guideline_text", lambda f, c: ""):
            response = self.client.post(
                f"/api/campaigns/{cid}/parse-guideline-file",
                files={"file": ("blank.pdf", b"%PDF-", "application/pdf")},
            )
        self.assertEqual(response.status_code, 422)
