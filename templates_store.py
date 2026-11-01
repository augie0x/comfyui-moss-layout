"""Template catalogue: the bundled templates plus templates users save from the editor.

Bundled templates live in ./templates/<category>/<id>.json (a layout per file).
User templates live under the ComfyUI user directory, so updating or reinstalling
the node keeps them: <user_root>/<category>/<id>.json holds {"name", "layout"},
and <user_root>/<category>/category.json holds the category's display name.
"""

import json
import os
import pathlib
import re
import tempfile

BUILTIN_DIR = pathlib.Path(__file__).parent / "templates"
CATEGORY_FILE = "category.json"
MAX_NAME = 80


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")[:MAX_NAME]


def _title(ident):
    return ident.replace("_", " ").title()


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _read_root(root, user):
    categories = {}
    if not root.is_dir():
        return categories
    for folder in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        meta = _read_json(folder / CATEGORY_FILE) if user else None
        entries = []
        try:
            paths = sorted(folder.glob("*.json"))
        except OSError:  # unreadable folder
            continue
        for path in paths:
            if path.name == CATEGORY_FILE:
                continue
            data = _read_json(path)
            if not isinstance(data, dict):
                continue
            if user:
                if not isinstance(data.get("layout"), dict):
                    continue
                entries.append({"id": path.stem, "name": data.get("name") or _title(path.stem), "user": True, "layout": data["layout"]})
            else:
                entries.append({"id": path.stem, "name": _title(path.stem), "user": False, "layout": data})
        name = meta.get("name") if isinstance(meta, dict) and meta.get("name") else _title(folder.name)
        categories[folder.name] = {"id": folder.name, "name": name, "templates": entries}
    return categories


def load_catalog(user_root, builtin_root=BUILTIN_DIR):
    """Categories sorted by name; user templates follow the bundled ones in a shared category."""
    merged = _read_root(pathlib.Path(builtin_root), user=False)
    for cid, cat in _read_root(pathlib.Path(user_root), user=True).items():
        if cid in merged:
            merged[cid]["templates"].extend(cat["templates"])
        else:
            merged[cid] = cat
    return sorted((c for c in merged.values() if c["templates"]), key=lambda c: c["name"].lower())


def _check_layout(layout):
    if not isinstance(layout, dict):
        raise ValueError("Layout must be a JSON object.")
    for key in ("width", "height"):
        if isinstance(layout.get(key), bool) or not isinstance(layout.get(key), int):
            raise ValueError(f"Layout {key} must be an integer.")
    if not isinstance(layout.get("summary"), dict):
        raise ValueError("Layout summary must be an object.")
    items = layout.get("items")
    if not isinstance(items, list):
        raise ValueError("Layout items must be a list.")
    for n, item in enumerate(items, 1):
        bbox = item.get("bbox") if isinstance(item, dict) else None
        if not (isinstance(bbox, list) and len(bbox) == 4 and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in bbox)):
            raise ValueError(f"BBOX {n} must have four numbers.")


def _write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def save_template(user_root, name, layout, category=None, new_category=None, overwrite=False, builtin_root=BUILTIN_DIR):
    """Save a user template. `category` is an existing category id; `new_category` a display name.

    Raises ValueError for bad input and FileExistsError when the template exists and
    `overwrite` is false. Returns the saved template's category id and id.
    """
    user_root, builtin_root = pathlib.Path(user_root), pathlib.Path(builtin_root)
    name = str(name or "").strip()
    tid = slug(name)
    if not tid:
        raise ValueError("Template name must contain letters or numbers.")
    _check_layout(layout)

    known = {c["id"] for c in load_catalog(user_root, builtin_root)}
    if new_category and str(new_category).strip():
        cat_name = str(new_category).strip()
        cid = slug(cat_name)
        if not cid:
            raise ValueError("Category name must contain letters or numbers.")
    else:
        cid = str(category or "")
        if cid not in known:
            raise ValueError("Choose an existing category or name a new one.")
        cat_name = None

    if (builtin_root / cid / f"{tid}.json").exists():
        raise ValueError(f'"{name}" is a built-in template name in this category; choose another name.')
    path = user_root / cid / f"{tid}.json"
    if path.exists() and not overwrite:
        raise FileExistsError(f'A saved template named "{name}" already exists in this category.')

    if cat_name and cid not in known and not (builtin_root / cid).is_dir():
        _write_json(user_root / cid / CATEGORY_FILE, {"name": cat_name})
    _write_json(path, {"name": name, "layout": layout})
    return {"category": cid, "id": tid}


def delete_template(user_root, category, template_id):
    """Delete a user template; bundled templates cannot be deleted. Empty user categories are removed."""
    user_root = pathlib.Path(user_root)
    if not category or not template_id or slug(category) != category or slug(template_id) != template_id:
        raise ValueError("Invalid template id.")
    path = user_root / category / f"{template_id}.json"
    if not path.is_file():
        raise FileNotFoundError("Saved template not found.")
    path.unlink()
    folder = path.parent
    if not any(p for p in folder.glob("*.json") if p.name != CATEGORY_FILE):
        (folder / CATEGORY_FILE).unlink(missing_ok=True)
        try:
            folder.rmdir()
        except OSError:
            pass
