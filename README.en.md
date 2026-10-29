# Unity Shader Tools

[简体中文](README.md) | **English**

A VSCode extension for Unity developers: full language intelligence for `.shader` / `.hlsl` files —
go to definition, completion, rename, hover, syntax & type diagnostics, and formatting.
Parsing runs on a custom tree-sitter ShaderLab grammar and HLSL dialect support; type checking calls
the official `dxc` compiler bundled with the extension — works out of the box, nothing else to install.

## Features — ShaderLab (`.shader`)

- Syntax highlighting (keywords, properties, passes, semantics)
- Document formatting (idempotent; never rewrites on failure)
- Go to definition / peek definition — cross-file, follows `#include` (Unity CGIncludes and package paths)
- Hover definition info (shader names, properties, HLSL symbols; common Unity built-ins via the bundled CGIncludes index)
- Find all references
- Rename symbol (shader names, two-step prepare/rename)
- Completion — shader names in `Fallback` / `UsePass`, `#include` paths, HLSL members after `.`
- Syntax diagnostics + dead-branch graying for conditional compilation
- DXC type diagnostics — official `dxc` bundled per platform (win32-x64/arm64, linux-x64, darwin-x64/arm64)
- Variant count report with material evidence (command palette)
- Convert language mode command — coexists with Unity for VS Code (VSTU) without touching user settings

## Features — HLSL (`.hlsl` / `.hlslinc` / `.cginc`)

- Syntax highlighting and formatting
- Cross-file go to definition, hover, find all references
- Completion (members after `.`, include paths)

## Notes

- Native modules ship inside the vsix per platform: win32-x64/arm64, linux-x64/arm64, darwin-x64/arm64;
  unsupported platforms fail loudly instead of silently losing intelligence
- Coexists with Unity for VS Code (VSTU): no user settings are changed by default; use the
  "convert language mode" command when you want this extension to take over

Source & feedback: <https://github.com/xiake-1/unity-shader-tools>
