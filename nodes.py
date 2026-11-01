"""ComfyUI node for MOSS-Image layout-to-image generation.

Port of the Curry-Sawce/moss-layout-studio Space (Apache-2.0). One node holds
the visual box editor (web/moss_layout_editor.js) and runs generation with
ComfyUI's native MOSS-Image support: the diffusion model, text encoder, VAE and
optional LoRA are picked from the ComfyUI models folders, nothing is downloaded.
"""

import json
import math
import pathlib

import torch

import comfy.model_management
import comfy.samplers
import folder_paths
import nodes
from comfy_extras.nodes_model_advanced import ModelSamplingSD3

from . import templates_store

MIN_EDGE = 256
MAX_PIXELS = 1_572_864
LATENT_CHANNELS = 128  # Flux2 latent format, 16x downscale
DEFAULT_LAYOUT = json.dumps({"width": 1024, "height": 1024, "summary": {"caption": ""}, "items": []})


def _files(folder, *prefer):
    """Filenames in a models folder; the default is the first name containing all of `prefer`."""
    names = folder_paths.get_filename_list(folder)
    default = next((n for n in names if all(p in n.lower() for p in prefer)), names[0] if names else None)
    return names, default


# ---------------------------------------------------------------------------
# Layout compilation
# ---------------------------------------------------------------------------

def compile_layout(state):
    """Editor state (absolute xyxy boxes) -> compact centralized-yxyx JSON prompt."""
    width, height = int(state["width"]), int(state["height"])
    if width < MIN_EDGE or height < MIN_EDGE:
        raise ValueError(f"Canvas edges must be at least {MIN_EDGE} px.")
    if width % 16 or height % 16:
        raise ValueError("Canvas width and height must be multiples of 16.")
    if width * height > MAX_PIXELS:
        raise ValueError("Canvas must not exceed 1.5 megapixels.")

    summary = dict(state.get("summary") or {})
    summary["caption"] = str(summary.get("caption", "")).strip()
    if not summary["caption"]:
        raise ValueError("Overall scene prompt is required.")
    items = state.get("items") or []
    if not items:
        raise ValueError("Draw at least one box before generating.")

    compiled_items = []
    for n, item in enumerate(items, 1):
        label = item.get("label", "object")
        caption = str(item.get("caption", "")).strip()
        text = str(item.get("text", ""))
        if not caption:
            raise ValueError(f"BBOX {n} needs a prompt.")
        if label == "text" and not text.strip():
            raise ValueError(f"BBOX {n} is a text item and needs exact visible text.")
        left, top, right, bottom = item["bbox"]
        left, top, right, bottom = math.floor(left), math.floor(top), math.ceil(right), math.ceil(bottom)
        if right <= left or bottom <= top:
            raise ValueError(f"BBOX {n} must have positive width and height.")
        if left < 0 or top < 0 or right > width or bottom > height:
            raise ValueError(f"BBOX {n} must remain inside the canvas.")
        out = {"label": label, "caption": caption,
               "bbox": [top - height // 2, left - width // 2, bottom - height // 2, right - width // 2]}
        if label == "text" or text.strip():
            out["text"] = text
        for key in ("tags", "palette"):
            if key in item:
                out[key] = item[key]
        compiled_items.append(out)

    compiled = {"summary": summary, "items": compiled_items,
                "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
    return json.dumps(compiled, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

class MossLayoutGenerate:
    _cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        unets, unet_default = _files("diffusion_models", "moss")
        tes, te_default = _files("text_encoders", "moss", "qwen3.5")
        vaes, vae_default = _files("vae", "flux2")
        loras = ["None"] + folder_paths.get_filename_list("loras")
        return {"required": {
            "layout_json": ("STRING", {"multiline": True, "default": DEFAULT_LAYOUT}),
            "diffusion_model": (unets, {"default": unet_default}),
            "text_encoder": (tes, {"default": te_default}),
            "vae": (vaes, {"default": vae_default}),
            "lora": (loras, {"default": "None", "tooltip": "Optional speed LoRA, e.g. the MOSS-Image-SFT 4-step Turbo LoRA."}),
            "lora_strength": ("FLOAT", {"default": 1.0, "min": -10.0, "max": 10.0, "step": 0.05}),
            "steps": ("INT", {"default": 8, "min": 1, "max": 200}),
            "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1}),
            "shift": ("FLOAT", {"default": 5.0, "min": 0.0, "max": 100.0, "step": 0.1}),
            "sampler_name": (comfy.samplers.KSampler.SAMPLERS, {"default": "euler"}),
            "scheduler": (comfy.samplers.KSampler.SCHEDULERS, {"default": "simple"}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
        }}

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "compiled_prompt")
    FUNCTION = "generate"
    CATEGORY = "MOSS Layout"

    def _load(self, kind, name, loader):
        key = (kind, name)
        if key not in self._cache:
            for old in [k for k in self._cache if k[0] == kind]:
                del self._cache[old]
            self._cache[key] = loader()
        return self._cache[key]

    def generate(self, layout_json, diffusion_model, text_encoder, vae, lora, lora_strength,
                 steps, cfg, shift, sampler_name, scheduler, seed):
        try:
            state = json.loads(layout_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Layout data is invalid: {exc}") from exc
        prompt = compile_layout(state)
        width, height = int(state["width"]), int(state["height"])

        model = self._load("unet", diffusion_model, lambda: nodes.UNETLoader().load_unet(diffusion_model, "default")[0])
        clip = self._load("clip", text_encoder, lambda: nodes.CLIPLoader().load_clip(text_encoder, type="moss_image")[0])
        vae_model = self._load("vae", vae, lambda: nodes.VAELoader().load_vae(vae)[0])

        if lora != "None" and lora_strength != 0:
            model = nodes.LoraLoaderModelOnly().load_lora_model_only(model, lora, lora_strength)[0]
        model = ModelSamplingSD3().patch(model, shift, multiplier=1.0)[0]

        encode = nodes.CLIPTextEncode().encode
        positive = encode(clip, prompt)[0]
        negative = encode(clip, "")[0]
        latent = {"samples": torch.zeros([1, LATENT_CHANNELS, height // 16, width // 16],
                                         device=comfy.model_management.intermediate_device())}
        samples = nodes.common_ksampler(model, seed, steps, cfg, sampler_name, scheduler,
                                        positive, negative, latent)[0]
        image = nodes.VAEDecode().decode(vae_model, samples)[0]
        return (image, prompt)


# ---------------------------------------------------------------------------
# Template catalogue routes for the editor UI
# ---------------------------------------------------------------------------

USER_TEMPLATE_DIR = pathlib.Path(folder_paths.get_user_directory()) / "moss_layout" / "templates"

try:
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes

    @routes.get("/moss_layout/templates")
    async def _list_templates(request):
        return web.json_response(templates_store.load_catalog(USER_TEMPLATE_DIR))

    @routes.post("/moss_layout/templates")
    async def _save_template(request):
        try:
            body = await request.json()
            saved = templates_store.save_template(
                USER_TEMPLATE_DIR, body.get("name"), body.get("layout"),
                category=body.get("category"), new_category=body.get("new_category"),
                overwrite=bool(body.get("overwrite")))
        except FileExistsError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except (ValueError, AttributeError) as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response(saved)

    @routes.delete("/moss_layout/templates/{category}/{template_id}")
    async def _delete_template(request):
        try:
            templates_store.delete_template(USER_TEMPLATE_DIR, request.match_info["category"], request.match_info["template_id"])
        except FileNotFoundError as exc:
            return web.json_response({"error": str(exc)}, status=404)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        return web.json_response({"deleted": True})
except ImportError:  # running outside ComfyUI
    pass


NODE_CLASS_MAPPINGS = {"MossLayoutGenerate": MossLayoutGenerate}
NODE_DISPLAY_NAME_MAPPINGS = {"MossLayoutGenerate": "MOSS Layout Generate"}
