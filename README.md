# ComfyUI MOSS Layout

ComfyUI port of the [moss-layout-studio](https://huggingface.co/spaces/Curry-Sawce/moss-layout-studio) Space (Apache-2.0), as a single node.
Base model `OpenMOSS-Team/MOSS-Image-SFT` (~27 GB, downloaded on first run) plus the 4-step Turbo LoRA `akhaliq/MOSS-Image-SFT-4-steps`.

## Install
Copy this folder to `ComfyUI/custom_nodes/`, run `pip install -r requirements.txt` in ComfyUI's Python environment, restart ComfyUI and hard-refresh the browser tab.

## Node: MOSS Layout Generate (category "MOSS Layout")
The visual editor is built into the node:
- Canvas size (multiples of 16, 256+, up to 1.5 MP), overall scene prompt, grid and snap.
- *Draw boxes* by dragging; *Select* to move/resize. Side panel: type (Object / Character / Text), region prompt, exact visible text.
- Undo, redo, duplicate, delete, clear.
- 45 bundled templates (same as the Space) via the Templates dropdown.
- Layout JSON panel: view/edit the draft, load JSON back (accepts the editor draft or a centralized yxyx model prompt).
- Generation settings on the node: Turbo LoRA, CPU offload, steps, cfg, shift, seed (use ComfyUI's seed "randomize" control for random seeds).
- Outputs `image` and `compiled_prompt` (the JSON prompt sent to the model).

Boxes are stored as absolute pixels from the top-left and converted to the centred `yxyx` format MOSS expects.
