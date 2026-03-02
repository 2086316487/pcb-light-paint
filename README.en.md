[简体中文](./README.md) | [English](#) | [繁體中文](./README.zh-Hant.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

# PCB Light Paint

PCB Light Paint is a plugin for the PCB workspace in JLCEDA / EasyEDA Pro.
It provides an end-to-end flow from image processing to PCB-ready layer assets,
and supports one-click primitive generation directly in the PCB document.

## Key Features

- Upload and edit source images (brush / lasso / fill)
- Palette-based image quantization
- Generate masks, layer outputs, and a physical preview
- Save single images or export ZIP packages
- One-click PCB art primitive generation (top/bottom/mask/silkscreen)

## Quick Start

1. Install `build/dist/pcb-light-paint_v0.1.6.eext`
2. Open any PCB document
3. Go to `PCB灯光画 -> 打开工作台`
4. Upload and process your image
5. Click `一键生成PCB画` or export assets

## Current Status

- Version: `0.1.6`
- Stable workflow is available: upload, edit, layer generation, export, build to PCB primitives
- 3D edge blank-ring issue is under active optimization (with experimental tuning)
