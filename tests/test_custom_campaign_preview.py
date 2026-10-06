import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

import app as app_module


class CustomSourcePreviewTests(unittest.TestCase):
    def setUp(self):
        self.draft_id = str(uuid.uuid4())
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.directory = Path(self.tempdir.name)
        self.source = self.directory / "campaign.mp4"
        self.source.write_bytes(b"0123456789abcdef")
        self.owner_checks = []

        async def assert_owner(request, requested_id):
            self.owner_checks.append(requested_id)
            if requested_id != self.draft_id:
                raise HTTPException(status_code=404, detail="Not found")
            return str(self.directory)

        self._patch("BILLING_ENABLED", False)
        self._patch("_assert_custom_draft_owner", assert_owner)
        self._patch("_read_custom_draft", lambda _draft_id: (str(self.directory), {"id": self.draft_id}))
        self._patch("_custom_source_path", lambda *_args: str(self.source))
        self.client = TestClient(app_module.app, raise_server_exceptions=False)

    def _patch(self, name, value):
        patcher = patch.object(app_module, name, value)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_source_preview_is_owner_checked_and_supports_byte_ranges(self):
        response = self.client.get(
            f"/api/custom/drafts/{self.draft_id}/source",
            headers={"Range": "bytes=2-6"},
        )

        self.assertEqual(response.status_code, 206)
        self.assertEqual(response.content, b"23456")
        self.assertEqual(response.headers["content-range"], "bytes 2-6/16")
        self.assertEqual(self.owner_checks, [self.draft_id])

    def test_source_preview_does_not_stream_for_another_owner(self):
        streamed = []

        async def reject_owner(_request, _draft_id):
            raise HTTPException(status_code=404, detail="Not found")

        self._patch("BILLING_ENABLED", True)
        self._patch("_assert_custom_draft_owner", reject_owner)
        self._patch("_custom_source_path", lambda *_args: streamed.append(True) or str(self.source))

        response = self.client.get(f"/api/custom/drafts/{self.draft_id}/source")

        self.assertEqual(response.status_code, 404)
        self.assertEqual(streamed, [])

    def test_source_url_mints_signed_media_url_in_billing_mode(self):
        self._patch("BILLING_ENABLED", True)
        self._patch("SOURCE_URL_TTL_SECONDS", 600)
        self._patch("_source_signature", lambda _draft_id, _exp: "signed")

        response = self.client.get(f"/api/custom/drafts/{self.draft_id}/source-url")

        self.assertEqual(response.status_code, 200)
        url = response.json()["url"]
        self.assertTrue(url.startswith(f"/api/custom/drafts/{self.draft_id}/source?exp="))
        self.assertTrue(url.endswith("&sig=signed"))


if __name__ == "__main__":
    unittest.main()

