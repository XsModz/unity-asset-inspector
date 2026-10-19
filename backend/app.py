from __future__ import annotations

import io
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any

from flask import Flask, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

import UnityPy


MAX_UPLOAD_BYTES = 250 * 1024 * 1024
SESSION_TTL_SECONDS = 60 * 60
API_VERSION = "1.0"
KNOWN_UNITY_HEADERS = (
    b"UnityFS",
    b"UnityWeb",
    b"UnityRaw",
    b"UnityArchive",
    b"UnityWebData1.0",
)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
FRONTEND_DIR = Path(__file__).resolve().parents[1] / "dist" / "public"


@app.after_request
def add_cors_headers(response):
    origin = request.headers.get("Origin")
    allowed_origins = {
        item.strip().rstrip("/")
        for item in os.environ.get("FRONTEND_ORIGINS", "").split(",")
        if item.strip()
    }
    if origin and origin.rstrip("/") in allowed_origins:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Max-Age"] = "600"
        response.headers.add("Vary", "Origin")
    return response


@dataclass
class AssetRecord:
    path_id: int
    name: str
    size: int
    class_name: str
    object_reader: Any
    tree: dict[str, Any] | None
    parse_error: str | None = None
    dirty: bool = False


@dataclass
class BundleSession:
    session_id: str
    file_name: str
    original_size: int
    temp_dir: Path
    environment: Any
    objects: dict[int, AssetRecord] = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
    last_used_at: float = field(default_factory=time.time)
    repacked_bytes: bytes | None = None
    repacked_name: str | None = None

    def touch(self) -> None:
        self.last_used_at = time.time()


sessions: dict[str, BundleSession] = {}
sessions_lock = Lock()


def error_response(message: str, status: int = 400):
    return jsonify({"error": message}), status


def json_safe(value: Any) -> Any:
    """Convert UnityPy values into values that can safely cross JSON."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, bytes):
        return {"__type": "bytes", "hex": value.hex()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}

    attrs = getattr(value, "__attrs_attrs__", None)
    if attrs:
        return {
            attribute.name: json_safe(getattr(value, attribute.name))
            for attribute in attrs
            if attribute.name not in {"assetsfile", "object_reader"}
        }

    if hasattr(value, "__dict__"):
        attrs = {
            key: json_safe(item)
            for key, item in vars(value).items()
            if not key.startswith("_") and key not in {"object_reader"}
        }
        if attrs:
            return attrs

    return str(value)


def read_full_typetree(reader: Any) -> dict[str, Any]:
    """Read the complete nested object tree across supported UnityPy versions."""
    read_typetree = getattr(reader, "read_typetree", None)
    if callable(read_typetree):
        value = read_typetree(wrap=False, check_read=False)
    else:
        parse_as_dict = getattr(reader, "parse_as_dict", None)
        if not callable(parse_as_dict):
            raise ValueError("This UnityPy reader cannot read a type tree.")
        value = parse_as_dict(check_read=False)

    safe_value = json_safe(value)
    if not isinstance(safe_value, dict):
        raise ValueError("UnityPy returned a non-object type tree.")
    return safe_value


def write_full_typetree(reader: Any, tree: dict[str, Any]) -> None:
    """Write a complete nested object tree using the current UnityPy API."""
    save_typetree = getattr(reader, "save_typetree", None)
    if callable(save_typetree):
        save_typetree(tree)
        return

    patch = getattr(reader, "patch", None)
    if callable(patch):
        patch(tree)
        return

    raise ValueError("This UnityPy reader cannot write a type tree.")


def searchable_text(value: Any) -> str:
    """Flatten keys and scalar values so nested fields are searchable."""
    parts: list[str] = []

    def visit(item: Any) -> None:
        if isinstance(item, dict):
            for key, child in item.items():
                parts.append(str(key))
                visit(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                visit(child)
        elif item is not None:
            parts.append(str(item))

    visit(value)
    return " ".join(parts)


def replace_string_values(value: Any, find: str, replacement: str, case_sensitive: bool) -> tuple[Any, int]:
    """Replace matching text in JSON string values without changing field names or scalar types."""
    if isinstance(value, str):
        if case_sensitive:
            changed, count = value.replace(find, replacement), value.count(find)
        else:
            changed, count = re.subn(re.escape(find), lambda _match: replacement, value, flags=re.IGNORECASE)
        return changed, count
    if isinstance(value, list):
        result: list[Any] = []
        count = 0
        for item in value:
            updated, item_count = replace_string_values(item, find, replacement, case_sensitive)
            result.append(updated)
            count += item_count
        return result, count
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        count = 0
        for key, item in value.items():
            updated, item_count = replace_string_values(item, find, replacement, case_sensitive)
            result[key] = updated
            count += item_count
        return result, count
    return value, 0


def cleanup_expired_sessions() -> None:
    now = time.time()
    expired: list[BundleSession] = []
    with sessions_lock:
        for session_id, session in list(sessions.items()):
            if now - session.last_used_at > SESSION_TTL_SECONDS:
                expired.append(session)
                del sessions[session_id]

    for session in expired:
        shutil.rmtree(session.temp_dir, ignore_errors=True)


def get_session(session_id: str) -> BundleSession | None:
    cleanup_expired_sessions()
    with sessions_lock:
        session = sessions.get(session_id)
        if session:
            session.touch()
        return session


def display_name(reader: Any, tree: dict[str, Any] | None, path_id: int) -> str:
    if isinstance(tree, dict):
        for key in ("m_Name", "name", "Name"):
            value = tree.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

    try:
        peeked = reader.peek_name()
        if isinstance(peeked, str) and peeked.strip():
            return peeked.strip()
    except Exception:
        pass

    return f"MonoBehaviour {path_id}"


def script_name(reader: Any) -> str:
    try:
        header = reader.parse_monobehaviour_head()
        script = header.m_Script.deref_parse_as_object()
        namespace = getattr(script, "m_Namespace", "")
        class_name = getattr(script, "m_ClassName", "")
        if class_name:
            return f"{namespace}.{class_name}" if namespace else class_name
    except Exception:
        pass
    return "MonoBehaviour"


def object_summary(record: AssetRecord) -> dict[str, Any]:
    return {
        # Unity PathIDs are signed 64-bit values. Keep them as strings so a
        # JavaScript client cannot round them before requesting the object.
        "path_id": str(record.path_id),
        "name": record.name,
        "size": record.size,
        "class_name": record.class_name,
        "editable": record.tree is not None,
        "parse_error": record.parse_error,
        "dirty": record.dirty,
        "search_text": searchable_text(record.tree),
    }


def session_summary(session: BundleSession) -> dict[str, Any]:
    records = sorted(session.objects.values(), key=lambda item: item.path_id)
    return {
        "session_id": session.session_id,
        "file_name": session.file_name,
        "file_size": session.original_size,
        "total_objects": len(records),
        "classes": sorted({record.class_name for record in records}),
        "objects": [object_summary(record) for record in records],
    }


def load_bundle(source_path: Path, file_name: str) -> BundleSession:
    with source_path.open("rb") as source:
        header = source.read(32)
    if not header.startswith(KNOWN_UNITY_HEADERS):
        raise ValueError("The file does not have a recognized Unity bundle header.")

    # Only use a key explicitly supplied by the bundle owner. UnityPy cannot
    # infer an encryption key from a UnityFS header or the error signatures.
    decrypt_key = os.environ.get("UNITY_BUNDLE_DECRYPT_KEY", "").strip()
    if decrypt_key:
        UnityPy.set_assetbundle_decrypt_key(decrypt_key)
    try:
        environment = UnityPy.load(str(source_path))
    except Exception as exc:
        if "encrypted" in str(exc).lower() and "key" in str(exc).lower():
            raise ValueError(
                "This bundle is encrypted. Configure UNITY_BUNDLE_DECRYPT_KEY "
                "with the correct key supplied by the file owner. The uploaded "
                "bundle alone does not provide that key. Encrypted round-trip "
                "saving is not yet supported; do not use this editor to replace "
                "the original encrypted file."
            ) from exc
        raise
    session = BundleSession(
        session_id=uuid.uuid4().hex,
        file_name=file_name,
        original_size=source_path.stat().st_size,
        temp_dir=source_path.parent,
        environment=environment,
    )

    for reader in environment.objects:
        if getattr(getattr(reader, "type", None), "name", None) != "MonoBehaviour":
            continue

        path_id = int(reader.path_id)
        tree: dict[str, Any] | None = None
        parse_error: str | None = None
        try:
            tree = read_full_typetree(reader)
        except Exception as exc:
            parse_error = (
                "UnityPy could not read this object's type tree. "
                "The object is visible but not editable."
            )
            app.logger.warning("Could not parse MonoBehaviour %s: %s", path_id, exc)

        record = AssetRecord(
            path_id=path_id,
            name=display_name(reader, tree, path_id),
            size=int(getattr(reader, "byte_size", 0)),
            class_name=script_name(reader),
            object_reader=reader,
            tree=tree,
            parse_error=parse_error,
        )
        session.objects[path_id] = record

    return session


@app.errorhandler(RequestEntityTooLarge)
def handle_too_large(_error):
    return error_response("That file is larger than the 250 MB upload limit.", 413)


@app.get("/unity-api/healthz")
def healthz():
    return jsonify({"status": "ok", "service": "unity-asset-inspector"})


@app.post("/unity-api/upload")
def upload_bundle():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return error_response("Choose a file to inspect first.")

    original_name = secure_filename(upload.filename) or "uploaded-asset"

    cleanup_expired_sessions()
    temp_dir = Path(tempfile.mkdtemp(prefix="unity-inspector-"))
    source_path = temp_dir / original_name

    try:
        upload.save(source_path)
        if source_path.stat().st_size == 0:
            raise ValueError("The uploaded file is empty.")
        session = load_bundle(source_path, original_name)
    except ValueError as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        app.logger.info("Rejected uploaded file %s: %s", original_name, exc)
        return error_response(str(exc), 422)
    except Exception as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        app.logger.warning("Bundle upload failed: %s", exc)
        return error_response(
            f"UnityPy could not read this file: {exc}",
            422,
        )

    with sessions_lock:
        sessions[session.session_id] = session

    return jsonify(session_summary(session))


@app.get("/unity-api/session/<session_id>")
def get_session_info(session_id: str):
    session = get_session(session_id)
    if session is None:
        return error_response("This inspection session has expired. Upload the bundle again.", 404)
    return jsonify(session_summary(session))


@app.get("/unity-api/session/<session_id>/objects")
def list_objects(session_id: str):
    session = get_session(session_id)
    if session is None:
        return error_response("This inspection session has expired. Upload the bundle again.", 404)

    query = request.args.get("search", "").strip().casefold()
    class_name = request.args.get("class", "").strip().casefold()
    editable_filter = request.args.get("editable")
    try:
        offset = max(0, int(request.args.get("offset", "0")))
        limit = min(1000, max(1, int(request.args.get("limit", "100"))))
    except ValueError:
        return error_response("offset and limit must be integers.", 400)

    records = sorted(session.objects.values(), key=lambda item: item.path_id)
    filtered: list[AssetRecord] = []
    for record in records:
        if query:
            haystack = f"{record.name} {record.class_name} {record.path_id} {searchable_text(record.tree)}".casefold()
            if query not in haystack:
                continue
        if class_name and class_name not in record.class_name.casefold():
            continue
        if editable_filter is not None:
            if editable_filter.casefold() not in {"true", "false"}:
                return error_response("editable must be true or false.", 400)
            requested_editable = editable_filter.casefold() == "true"
            if (record.tree is not None) != requested_editable:
                continue
        filtered.append(record)

    page = filtered[offset : offset + limit]
    return jsonify(
        {
            "session_id": session.session_id,
            "objects": [object_summary(record) for record in page],
            "total": len(filtered),
            "offset": offset,
            "limit": limit,
        }
    )


@app.get("/unity-api")
def api_index():
    return jsonify(
        {
            "name": "Unity Asset Inspector API",
            "version": API_VERSION,
            "health": "/unity-api/healthz",
            "openapi": "/unity-api/openapi.json",
            "resources": {
                "upload": "POST /unity-api/upload",
                "session": "GET /unity-api/session/{session_id}",
                "objects": "GET /unity-api/session/{session_id}/objects",
                "object": "GET|PUT /unity-api/session/{session_id}/object/{path_id}",
                "batch_replace": "POST /unity-api/session/{session_id}/batch-replace",
                "repack": "POST /unity-api/session/{session_id}/repack",
                "download": "GET /unity-api/session/{session_id}/download",
            },
        }
    )


@app.get("/unity-api/openapi.json")
def openapi_document():
    return jsonify(
        {
            "openapi": "3.0.3",
            "info": {
                "title": "Unity Asset Inspector API",
                "version": API_VERSION,
                "description": "Upload, inspect, edit, repack, and download Unity asset bundles.",
            },
            "paths": {
                "/unity-api/healthz": {"get": {"responses": {"200": {"description": "Service health."}}}},
                "/unity-api/upload": {
                    "post": {
                        "summary": "Upload and parse a Unity asset bundle.",
                        "requestBody": {"required": True, "content": {"multipart/form-data": {"schema": {"type": "object", "required": ["file"], "properties": {"file": {"type": "string", "format": "binary"}}}}}},
                        "responses": {"200": {"description": "Parsed inspection session."}, "422": {"description": "The uploaded bytes are not readable by UnityPy."}},
                    }
                },
                "/unity-api/session/{session_id}": {"get": {"summary": "Get session metadata and all object summaries."}},
                "/unity-api/session/{session_id}/objects": {"get": {"summary": "List filtered objects with offset and limit pagination."}},
                "/unity-api/session/{session_id}/object/{path_id}": {
                    "get": {"summary": "Get one object's serialized JSON."},
                    "put": {"summary": "Patch one editable MonoBehaviour with serialized JSON."},
                },
                "/unity-api/session/{session_id}/batch-replace": {"post": {"summary": "Preview or apply string-value replacements across editable MonoBehaviour objects."}},
                "/unity-api/session/{session_id}/repack": {"post": {"summary": "Repack the active Unity environment."}},
                "/unity-api/session/{session_id}/download": {"get": {"summary": "Download the most recent repacked bytes."}},
            },
        }
    )


@app.get("/unity-api/session/<session_id>/object/<path:path_id>")
def get_object(session_id: str, path_id: str):
    session = get_session(session_id)
    if session is None:
        return error_response("This inspection session has expired. Upload the bundle again.", 404)

    try:
        object_path_id = int(path_id)
    except ValueError:
        return error_response("path_id must be a signed integer.", 400)

    record = session.objects.get(object_path_id)
    if record is None:
        return error_response(f"MonoBehaviour object {path_id} was not found.", 404)

    return jsonify(
        {
            **object_summary(record),
            "json": record.tree,
        }
    )


@app.put("/unity-api/session/<session_id>/object/<path:path_id>")
def update_object(session_id: str, path_id: str):
    session = get_session(session_id)
    if session is None:
        return error_response("This inspection session has expired. Upload the bundle again.", 404)

    try:
        object_path_id = int(path_id)
    except ValueError:
        return error_response("path_id must be a signed integer.", 400)

    record = session.objects.get(object_path_id)
    if record is None:
        return error_response(f"MonoBehaviour object {path_id} was not found.", 404)
    if record.tree is None:
        return error_response(record.parse_error or "This object is not editable.", 422)

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or "json" not in payload:
        return error_response("Send a JSON object in the request body under the 'json' key.")
    if not isinstance(payload["json"], dict):
        return error_response("MonoBehaviour JSON must be an object.")

    try:
        json.dumps(payload["json"])
    except (TypeError, ValueError) as exc:
        return error_response(f"JSON contains an unsupported value: {exc}")

    try:
        write_full_typetree(record.object_reader, payload["json"])
    except Exception as exc:
        app.logger.warning("UnityPy rejected update for %s: %s", object_path_id, exc)
        return error_response(
            "UnityPy could not write this type tree. Check the field names and value types.",
            422,
        )

    record.tree = payload["json"]
    record.size = int(getattr(record.object_reader, "byte_size", record.size))
    record.dirty = True
    session.repacked_bytes = None
    return jsonify(object_summary(record) | {"json": record.tree})


@app.post("/unity-api/session/<session_id>/batch-replace")
def batch_replace(session_id: str):
    session = get_session(session_id)
    if session is None:
        return error_response("This inspection session has expired. Upload the bundle again.", 404)

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return error_response("Send a JSON object with find and replace values.")
    find = payload.get("find")
    replacement = payload.get("replace")
    case_sensitive = payload.get("case_sensitive", False)
    preview = payload.get("preview", True)
    if not isinstance(find, str) or not find:
        return error_response("find must be a non-empty string.")
    if len(find) > 500 or not isinstance(replacement, str) or len(replacement) > 2000:
        return error_response("find must be at most 500 characters and replace at most 2,000 characters.")
    if not isinstance(case_sensitive, bool) or not isinstance(preview, bool):
        return error_response("case_sensitive and preview must be booleans.")

    matched_count = 0
    changed_objects: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for record in session.objects.values():
        if record.tree is None or record.class_name == "MonoBehaviour" and record.parse_error:
            continue
        updated, occurrence_count = replace_string_values(record.tree, find, replacement, case_sensitive)
        if occurrence_count == 0:
            continue
        matched_count += occurrence_count
        if preview:
            continue

        original = record.tree
        try:
            write_full_typetree(record.object_reader, updated)
            record.tree = updated
            record.size = int(getattr(record.object_reader, "byte_size", record.size))
            record.dirty = True
            changed_objects.append(object_summary(record))
        except Exception as exc:
            try:
                write_full_typetree(record.object_reader, original)
            except Exception:
                app.logger.exception("Could not restore object %s after failed batch replacement", record.path_id)
            failed.append({"path_id": str(record.path_id), "error": f"UnityPy rejected this object's updated type tree: {exc}"})

    if not preview and changed_objects:
        session.repacked_bytes = None
        session.repacked_name = None
    return jsonify({
        "preview": preview,
        "matched_count": matched_count,
        "changed_count": len(changed_objects),
        "objects": changed_objects,
        "failed": failed,
    })


@app.post("/unity-api/session/<session_id>/repack")
def repack_bundle(session_id: str):
    session = get_session(session_id)
    if session is None:
        return error_response("This inspection session has expired. Upload the bundle again.", 404)

    try:
        saved = session.environment.file.save()
        if not isinstance(saved, (bytes, bytearray)):
            raise ValueError("UnityPy did not return bundle bytes.")
        candidate = bytes(saved)
        # Strict fixed-size export: never emit a file even one byte larger.
        # Do not append arbitrary padding to a UnityFS bundle: it may corrupt
        # offsets, checksums, or readers. A smaller output is not automatically
        # equivalent to the original fixed-size container either.
        if len(candidate) != session.original_size:
            session.repacked_bytes = None
            session.repacked_name = None
            difference = len(candidate) - session.original_size
            raise ValueError(
                f"Fixed-size export refused: original {session.original_size} bytes, "
                f"repacked {len(candidate)} bytes (difference {difference:+d}). "
                "The current UnityPy serializer cannot guarantee an exactly "
                "equal-size valid bundle for this edit. No invalid padding was added."
            )
        session.repacked_bytes = candidate
        base_name = Path(session.file_name).stem
        session.repacked_name = f"{base_name}.edited{Path(session.file_name).suffix}"
    except Exception as exc:
        app.logger.exception("Bundle repack failed")
        return error_response(
            f"UnityPy could not repack this bundle: {exc}",
            422,
        )

    return jsonify(
        {
            "download_url": f"/unity-api/session/{session.session_id}/download",
            "file_name": session.repacked_name,
            "file_size": len(session.repacked_bytes),
        }
    )


@app.get("/unity-api/session/<session_id>/download")
def download_bundle(session_id: str):
    session = get_session(session_id)
    if session is None:
        return error_response("This inspection session has expired. Upload the bundle again.", 404)
    if session.repacked_bytes is None or not session.repacked_name:
        return error_response("Save the edited bundle before downloading it.", 409)

    return send_file(
        io.BytesIO(session.repacked_bytes),
        as_attachment=True,
        download_name=session.repacked_name,
        mimetype="application/octet-stream",
    )


@app.get("/", defaults={"path": ""})
@app.get("/<path:path>")
def frontend(path: str):
    """Serve the built React app when Flask is used as the single web service."""
    if path.startswith("unity-api/"):
        return error_response("API route not found.", 404)

    requested = FRONTEND_DIR / path
    if path and requested.is_file():
        return send_from_directory(FRONTEND_DIR, path)

    index_file = FRONTEND_DIR / "index.html"
    if index_file.is_file():
        return send_file(index_file)

    return error_response(
        "The frontend build is not available yet. Run the Vite build first.",
        503,
    )


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        debug=os.environ.get("FLASK_DEBUG") == "1",
    )