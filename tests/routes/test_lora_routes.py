import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from py.routes.lora_routes import LoraRoutes
from server import PromptServer  # pyright: ignore[reportMissingImports]


class DummyRequest:
    def __init__(self, *, query=None, match_info=None, json_data=None):
        self.query = query or {}
        self.match_info = match_info or {}
        self._json_data = json_data or {}

    async def json(self):
        return self._json_data


class StubLoraService:
    def __init__(self):
        self.trigger_words = {}
        self.usage_tips = {}

    async def get_lora_trigger_words(self, name):
        return self.trigger_words.get(name, [])

    async def get_lora_usage_tips_by_relative_path(self, path):
        return self.usage_tips.get(path)


@pytest.fixture
def routes():
    handler = LoraRoutes()
    handler.service = StubLoraService()  # pyright: ignore[reportAttributeAccessIssue]
    return handler


async def test_get_lora_trigger_words_success(routes):
    routes.service.trigger_words["demo"] = ["trigger"]
    response = await routes.get_lora_trigger_words(DummyRequest(query={"name": "demo"}))
    payload = json.loads(response.text)
    assert payload == {"success": True, "trigger_words": ["trigger"]}


async def test_get_lora_trigger_words_missing_name(routes):
    response = await routes.get_lora_trigger_words(DummyRequest())
    assert response.status == 400


async def test_get_lora_trigger_words_error(routes):
    async def failing(*_args, **_kwargs):
        raise RuntimeError("fail")

    routes.service.get_lora_trigger_words = failing

    response = await routes.get_lora_trigger_words(DummyRequest(query={"name": "demo"}))
    payload = json.loads(response.text)
    assert response.status == 500
    assert payload["success"] is False


async def test_get_usage_tips_success(routes):
    routes.service.usage_tips["path"] = "tips"
    response = await routes.get_lora_usage_tips_by_path(DummyRequest(query={"relative_path": "path"}))
    payload = json.loads(response.text)
    assert payload == {"success": True, "usage_tips": "tips"}


async def test_get_usage_tips_missing_param(routes):
    response = await routes.get_lora_usage_tips_by_path(DummyRequest())
    assert response.status == 400


async def test_get_usage_tips_error(routes):
    async def failing(*_args, **_kwargs):
        raise RuntimeError("bad")

    routes.service.get_lora_usage_tips_by_relative_path = failing
    response = await routes.get_lora_usage_tips_by_path(DummyRequest(query={"relative_path": "path"}))
    payload = json.loads(response.text)
    assert response.status == 500
    assert payload["success"] is False


async def test_get_trigger_words_broadcasts(monkeypatch, routes):
    send_mock = MagicMock()
    PromptServer.instance = SimpleNamespace(send_sync=send_mock)

    monkeypatch.setattr("py.routes.lora_routes.get_lora_info", lambda name: (f"path/{name}", [f"trigger-{name}"]))
    monkeypatch.setattr(
        LoraRoutes,
        "_load_lora_trigger_sets",
        staticmethod(lambda name: {"trigger_sets": [], "active_set_id": "default"}),
    )

    request = DummyRequest(json_data={"lora_names": ["one"], "node_ids": [{"node_id": "node", "graph_id": "graph-1"}]})

    response = await routes.get_trigger_words(request)
    payload = json.loads(response.text)

    assert payload == {"success": True}
    send_mock.assert_called_once_with(
        "trigger_word_update",
        {
            "id": "node",
            "graph_id": "graph-1",
            "message": "trigger-one",
            "loras": [
                {
                    "name": "one",
                    "trigger_words": ["trigger-one"],
                    "trigger_sets": [
                        {"id": "default", "name": "Default", "groups": ["trigger-one"]}
                    ],
                    "active_set_id": "default",
                }
            ],
        },
    )


async def test_get_trigger_words_includes_sets_and_seq_per_node(monkeypatch, routes):
    send_mock = MagicMock()
    PromptServer.instance = SimpleNamespace(send_sync=send_mock)

    monkeypatch.setattr("py.routes.lora_routes.get_lora_info", lambda name: (name, ["a, b"]))
    extra = [{"id": "set-1", "name": "Alt", "groups": ["c"]}]
    monkeypatch.setattr(
        LoraRoutes,
        "_load_lora_trigger_sets",
        staticmethod(lambda name: {"trigger_sets": extra, "active_set_id": "set-1"}),
    )

    request = DummyRequest(
        json_data={
            "lora_names": ["one"],
            "node_ids": [{"node_id": "1", "seq": 7}, {"node_id": "2", "seq": 3}],
        }
    )
    await routes.get_trigger_words(request)

    sent = [call.args[1] for call in send_mock.call_args_list]
    assert [(p["id"], p["seq"]) for p in sent] == [(1, 7), (2, 3)]
    assert sent[0]["message"] == "a, b"
    assert [s["id"] for s in sent[0]["loras"][0]["trigger_sets"]] == ["default", "set-1"]
    assert sent[0]["loras"][0]["active_set_id"] == "set-1"


class StubScanner:
    def __init__(self, paths):
        self._cache = SimpleNamespace(raw_data=[{"file_path": p} for p in paths])

    async def get_cached_data(self):
        return self._cache


def _write_sidecar(tmp_path, data):
    model = tmp_path / "demo.safetensors"
    model.write_bytes(b"")
    (tmp_path / "demo.metadata.json").write_text(json.dumps(data), encoding="utf-8")
    return str(model)


async def test_trigger_sets_roundtrip_preserves_trained_words(tmp_path, routes):
    model_path = _write_sidecar(
        tmp_path,
        {
            "file_name": "demo",
            "civitai": {
                "trainedWords": ["keep, me"],
                "triggerSets": [{"id": "old", "name": "Old", "groups": ["x"]}],
                "activeTriggerSetId": "old",
            },
        },
    )
    routes.service.scanner = StubScanner([model_path])

    response = await routes.get_trigger_sets(DummyRequest(query={"file_path": model_path}))
    assert json.loads(response.text)["trigger_sets"] == [{"id": "old", "name": "Old", "groups": ["x"]}]

    response = await routes.update_trigger_sets(
        DummyRequest(
            json_data={
                "file_path": model_path,
                "trigger_sets": [
                    {"id": "old", "name": "Old", "groups": ["x"]},
                    {"name": "New", "groups": ["y", " "]},
                ],
            }
        )
    )
    payload = json.loads(response.text)
    assert payload["success"] is True
    assert payload["trigger_sets"][1]["name"] == "New"
    assert payload["trigger_sets"][1]["groups"] == ["y"]
    assert payload["trigger_sets"][1]["id"].startswith("set-")

    saved = json.loads((tmp_path / "demo.metadata.json").read_text(encoding="utf-8"))
    assert saved["civitai"]["trainedWords"] == ["keep, me"]
    assert "triggerSets" not in saved["civitai"]
    assert "activeTriggerSetId" not in saved["civitai"]
    assert saved["trigger_sets"] == payload["trigger_sets"]
    assert saved["active_trigger_set_id"] == "old"


async def test_update_trigger_sets_rejects_unknown_path(tmp_path, routes):
    model_path = _write_sidecar(tmp_path, {"file_name": "demo"})
    routes.service.scanner = StubScanner([])

    response = await routes.update_trigger_sets(
        DummyRequest(json_data={"file_path": model_path, "trigger_sets": []})
    )
    assert response.status == 404


async def test_update_trigger_sets_rejects_reserved_id(tmp_path, routes):
    model_path = _write_sidecar(tmp_path, {"file_name": "demo"})
    routes.service.scanner = StubScanner([model_path])

    response = await routes.update_trigger_sets(
        DummyRequest(json_data={"file_path": model_path, "trigger_sets": [{"id": "default", "name": "x"}]})
    )
    assert response.status == 400


async def test_get_trigger_words_error(monkeypatch, routes):
    async def failing_json():
        raise RuntimeError("bad json")

    request = DummyRequest(json_data=None)
    request.json = failing_json

    response = await routes.get_trigger_words(request)
    payload = json.loads(response.text)
    assert response.status == 500
    assert payload["success"] is False
