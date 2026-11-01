"""ComfyUI node for MOSS-Image layout-to-image generation.

Port of the Curry-Sawce/moss-layout-studio Space (Apache-2.0). One node holds
the visual box editor (web/moss_layout_editor.js) and runs generation: boxes
are compiled to the centralized-yxyx JSON prompt MOSS-Image expects, and the
4-step Turbo LoRA is applied to the transformer.
"""

import json
import math
import pathlib

import numpy as np
import torch
from torch import nn

MODEL_REPO = "OpenMOSS-Team/MOSS-Image-SFT"
LORA_REPO = "akhaliq/MOSS-Image-SFT-4-steps"
LORA_TARGETS = ("q", "k", "v", "o", "ffn_up_gate", "ffn_down")
LORA_RANK = 128
MIN_EDGE = 256
MAX_PIXELS = 1_572_864
TEMPLATE_DIR = pathlib.Path(__file__).parent / "templates"
DEFAULT_LAYOUT = json.dumps({"width": 1024, "height": 1024, "summary": {"caption": ""}, "items": []})


# ---------------------------------------------------------------------------
# Turbo LoRA (the custom pipeline has no diffusers LoRA mixin)
# ---------------------------------------------------------------------------

class LoRALinear(nn.Module):
    def __init__(self, base, rank, alpha):
        super().__init__()
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)
        self.lora_down = nn.Linear(base.in_features, rank, bias=False)
        self.lora_up = nn.Linear(rank, base.out_features, bias=False)
        self.rank, self.alpha = rank, alpha

    @property
    def weight(self):
        return self.base.weight

    def forward(self, x):
        out = self.base(x)
        delta = self.lora_up(self.lora_down(x.to(self.lora_down.weight.dtype)))
        return out + (delta * (self.alpha / self.rank)).to(out.dtype)


def apply_turbo_lora(transformer, strength=1.0):
    from huggingface_hub import hf_hub_download
    from safetensors.torch import load_file

    for layer in transformer.layers:
        for name in LORA_TARGETS:
            layer.proj[name] = LoRALinear(layer.proj[name], LORA_RANK, LORA_RANK * strength)
    sd = load_file(hf_hub_download(LORA_REPO, "lora.safetensors"))
    for i, layer in enumerate(transformer.layers):
        for name in LORA_TARGETS:
            m = layer.proj[name]
            key = f"diffusion_model.layers.{i}.proj.{name}"
            m.lora_down.weight.data.copy_(sd[f"{key}.lora_down.weight"])
            m.lora_up.weight.data.copy_(sd[f"{key}.lora_up.weight"])
            m.alpha = float(sd[f"{key}.alpha"]) * strength
    return transformer


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
    _pipes = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "layout_json": ("STRING", {"multiline": True, "default": DEFAULT_LAYOUT}),
            "turbo_lora": ("BOOLEAN", {"default": True}),
            "offload": (["model_cpu_offload", "none"], {"default": "model_cpu_offload"}),
            "steps": ("INT", {"default": 4, "min": 1, "max": 100}),
            "cfg": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 20.0, "step": 0.1}),
            "shift": ("FLOAT", {"default": 5.0, "min": 1.0, "max": 10.0, "step": 0.1}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
        }}

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("image", "compiled_prompt")
    FUNCTION = "generate"
    CATEGORY = "MOSS Layout"

    def _pipe(self, turbo_lora, offload):
        key = (turbo_lora, offload)
        if key not in self._pipes:
            self._pipes.clear()
            torch.cuda.empty_cache()
            from diffusers import DiffusionPipeline
            pipe = DiffusionPipeline.from_pretrained(
                MODEL_REPO, custom_pipeline="pipeline_moss_image", trust_remote_code=True,
                torch_dtype={"default": torch.bfloat16, "vae": torch.float32},
            )
            if turbo_lora:
                apply_turbo_lora(pipe.transformer)
            if offload == "model_cpu_offload":
                pipe.enable_model_cpu_offload()
            else:
                pipe.to("cuda" if torch.cuda.is_available() else "cpu")
            self._pipes[key] = pipe
        return self._pipes[key]

    def generate(self, layout_json, turbo_lora, offload, steps, cfg, shift, seed):
        try:
            state = json.loads(layout_json)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Layout data is invalid: {exc}") from exc
        prompt = compile_layout(state)
        width, height = int(state["width"]), int(state["height"])
        pipe = self._pipe(turbo_lora, offload)
        pipe.scheduler = type(pipe.scheduler).from_config(pipe.scheduler.config, shift=float(shift))
        image = pipe(
            prompt,
            height=height,
            width=width,
            num_inference_steps=steps,
            guidance_scale=float(cfg),
            uncond_skip_layers=[22],
            generator=torch.Generator("cpu").manual_seed(seed % (2 ** 32)),
        ).images[0]
        tensor = torch.from_numpy(np.asarray(image.convert("RGB")).astype(np.float32) / 255.0)[None]
        return (tensor, prompt)


# ---------------------------------------------------------------------------
# Template catalogue for the editor UI
# ---------------------------------------------------------------------------

def load_templates():
    catalog = []
    folders = sorted(p for p in TEMPLATE_DIR.iterdir() if p.is_dir()) if TEMPLATE_DIR.exists() else []
    for folder in folders:
        entries = []
        for path in sorted(folder.glob("*.json")):
            try:
                layout = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            entries.append({"id": path.stem, "name": path.stem.replace("_", " ").title(), "layout": layout})
        if entries:
            catalog.append({"id": folder.name, "name": folder.name.replace("_", " ").title(), "templates": entries})
    return catalog


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/moss_layout/templates")
    async def _templates(request):
        return web.json_response(load_templates())
except ImportError:  # running outside ComfyUI
    pass


NODE_CLASS_MAPPINGS = {"MossLayoutGenerate": MossLayoutGenerate}
NODE_DISPLAY_NAME_MAPPINGS = {"MossLayoutGenerate": "MOSS Layout Generate"}
