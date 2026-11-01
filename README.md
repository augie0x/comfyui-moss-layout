# ComfyUI MOSS Layout

ComfyUI port of the [moss-layout-studio](https://huggingface.co/spaces/Curry-Sawce/moss-layout-studio) Space (Apache-2.0), as a single node.
It uses ComfyUI's built-in MOSS-Image support and the model files already in your ComfyUI `models` folders. Nothing is downloaded.

## Requirements
- A ComfyUI version with native MOSS-Image support (0.42 or later).
- Model files:
  - `models/diffusion_models`: MOSS-Image SFT (e.g. `mossImage_sft_bf16.safetensors`)
  - `models/text_encoders`: Qwen3.5-9B text encoder for MOSS-Image
  - `models/vae`: Flux 2 VAE (e.g. `flux2-vae.safetensors`)
  - `models/loras` (optional): a speed LoRA, e.g. the 4-step Turbo LoRA from `akhaliq/MOSS-Image-SFT-4-steps`

## Install
Download and copy this folder to `ComfyUI/custom_nodes/`, restart ComfyUI and hard-refresh the browser tab.
OR
git pull into `ComfyUI/custom_nodes/`, restart ComfyUI and hard-refresh (Ctrl+F5) the browser tab.

## Node: MOSS Layout Generate (category "MOSS Layout")
The visual editor is built into the node:
- Canvas size (multiples of 16, 256+, up to 1.5 MP), overall scene prompt, grid and snap.
- *Draw boxes* by dragging; *Select* to move/resize. Side panel: type (Object / Character / Text), region prompt, exact visible text.
- Undo, redo, duplicate, delete, clear.
- 45 bundled templates (same as the Space) via the Templates dropdown.
- Your own templates: *Save as template* stores the current layout under a name, in an existing category or a new one. Saved templates appear in the same Templates list, marked "(saved)". *Delete template* removes a saved template; bundled templates cannot be deleted.
  Saved templates are kept in `ComfyUI/user/moss_layout/templates/`, so updating or reinstalling the node does not remove them.
- Layout JSON panel: view/edit the draft, load JSON back (accepts the editor draft or a centralized yxyx model prompt).

Generation settings on the node: diffusion model, text encoder, VAE, optional LoRA and strength, steps, cfg, shift (default 5), sampler, scheduler and seed.
With a 4-step LoRA use 4 steps and cfg 1.0; without a LoRA use more steps.
Outputs `image` and `compiled_prompt` (the JSON prompt sent to the model).

## Test
Tested with 8 step LoRA

