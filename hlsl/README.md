# hlsl — tree-sitter-hlsl 的本地 fork

来源：npm `tree-sitter-hlsl@0.2.0`（[tree-sitter-grammars/tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl)，2025-03），
复制于 2026-10-28。决策见 [docs/decisions/0007](../docs/decisions/0007-fork-tree-sitter-hlsl-workspace.md)。

包名保持 `tree-sitter-hlsl`（版本 0.2.1），server 的 `^0.2.0` 依赖由 npm workspaces 解析到本包。

## 本地补丁（grammar.js「本地补丁」段）

1. **struct 体内裸宏成员**：`_field_declaration_list_item` 扩展点挂 `macro_member`
   （`UNITY_VERTEX_INPUT_INSTANCE_ID` 等无类型无分号成员；上游会把 struct 收尾 `};` 变
   ERROR 并级联吞掉整文件，UnityCG.cginc 的 `appdata_base` 等因此从符号索引消失）。
2. **跨行宏体内块注释**：`preproc_arg` 字符类允许 `/* */`（`\` 续行的 `#define` 体内，
   UnityPBSLighting / UnityLegacyTextureStack 等）。

语料测试：`test/corpus/unity-macros.txt`（`npm run hlsl:test`）。

## 重新生成 / 编译

`src/parser.c` 是生成物（同 `grammar/`，不入库）。**全新克隆先 `npm install --ignore-scripts`**
（否则 npm 对 binding.gyp 自动 rebuild 会因缺 parser.c 失败），然后：

```
npm run hlsl:generate   # tree-sitter generate → src/parser.c（ABI 14，勿升 ABI）
npm run hlsl:compile    # node-gyp rebuild → build/Release/*.node（node-gyp-build 运行时加载）
```

升级上游时：重新复制上游包 → 把 grammar.js 的补丁段与 conflicts 列表 rebase → 上面两条命令 →
`npx vitest run`（hlsl.test.ts / definitionRealProject.test.ts 有回归钉）。
