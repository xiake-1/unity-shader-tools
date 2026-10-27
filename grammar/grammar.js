/**
 * shaderlab grammar — Unity ShaderLab 外壳（T-003）
 *
 * 设计要点（ADR 0001 / 规格 feature-language-server-core）：
 * - 关键字大小写不敏感：全部由外部 scanner（src/scanner.c）产出为命名 external token。
 *   scanner 依赖 parser 传入的 valid_symbols 做上下文判定 —— 在 Properties / Stencil{…}
 *   等上下文里关键字不是合法 token，于是同一词按 `word`/`prop_name` 词法，
 *   无需枚举大小写组合，也不误伤属性名（对标产品枚举 32 种大小写的反面经验）。
 * - 程序块：`_hlsl_block` / `_cg_block` / `_glsl_block` 是 scanner 产出的隐藏 external，
 *   内容作为单个叶子被消费；服务端（T-004）用 tree-sitter-hlsl 对 `_hlsl_block` 的字节区间
 *   二次解析并映射偏移。CG/GLSL 不做语义（project.md 不在范围）。
 * - ShaderLab 层预处理器（#include/#define/#if…）作为 extras，任何层均可出现。
 */
module.exports = grammar({
  name: 'shaderlab',

  externals: $ => [
    $._hlsl_block,
    $._cg_block,
    $._glsl_block,
    $.kw_shader,
    $.kw_category,
    $.kw_subshader,
    $.kw_pass,
    $.kw_tags,
    $.kw_properties,
    $.kw_name,
    $.kw_lod,
    $.kw_usepass,
    $.kw_grabpass,
    $.kw_fallback,
    $.kw_customeditor,
    $.kw_hlslprogram,
    $.kw_hlslinclude,
    $.kw_endhlsl,
    $.kw_cgprogram,
    $.kw_endcg,
    $.kw_glslprogram,
    $.kw_endglsl,
    $.kw_include,
    $.kw_define,
    $.kw_undef,
    $.kw_if,
    $.kw_ifdef,
    $.kw_ifndef,
    $.kw_elif,
    $.kw_else,
    $.kw_endif,
    $.kw_off,
    $.kw_cginclude,
  ],

  extras: $ => [
    /\s|;/,
    $.comment,
    $.preproc_include,
    $.preproc_def,
    $.preproc_undef,
    $.preproc_if,
    $.preproc_ifdef,
    $.preproc_ifndef,
    $.preproc_elif,
    $.preproc_else,
    $.preproc_endif,
  ],

  rules: {
    source_file: $ => repeat($.shader_block),

    shader_block: $ => seq(
      $.kw_shader,
      $.string,
      '{',
      repeat(choice(
        $.properties_block,
        $.category_block,
        $.subshader_block,
        $.fallback,
        $.custom_editor,
        $.state_command,
      )),
      '}',
    ),

    category_block: $ => seq(
      $.kw_category,
      optional($.string),
      '{',
      repeat(choice(
        $.properties_block,
        $.subshader_block,
        $.fallback,
        $.custom_editor,
        $.state_command,
      )),
      '}',
    ),

    subshader_block: $ => seq(
      $.kw_subshader,
      optional($.string),
      '{',
      repeat($.block_item),
      '}',
    ),

    pass_block: $ => seq(
      $.kw_pass,
      optional($.string),
      '{',
      repeat($.block_item),
      '}',
    ),

    // SubShader 与 Pass 的公共成员集合（Pass 可嵌套出现于 SubShader；Pass 内再嵌 Pass
    // 语法上容忍，实际不会出现，换来的是单一成员集合规则）
    block_item: $ => choice(
      $.pass_block,
      $.tags_block,
      $.name_decl,
      $.lod_decl,
      $.use_pass,
      $.grab_pass,
      $.program_hlsl,
      $.program_hlsl_include,
      $.program_cg,
      $.program_cg_include,
      $.program_glsl,
      $.state_command,
    ),

    tags_block: $ => seq(
      $.kw_tags,
      '{',
      repeat($.tag_item),
      '}',
    ),

    tag_item: $ => seq($.string, '=', choice($.string, $.number)),

    name_decl: $ => seq($.kw_name, $.string),
    lod_decl: $ => seq($.kw_lod, $.number),
    use_pass: $ => seq($.kw_usepass, $.string),
    // `GrabPass { … }` / `GrabPass "name"`
    grab_pass: $ => prec.right(seq($.kw_grabpass, optional(choice($.string, $._braced_body)))),

    // `Fallback Off`：kw_off 只在 fallback 之后是合法 token（valid_symbols 驱动），
    // 因此 `Cull Off` 里的 Off 仍按 word 词法，不冲突。
    fallback: $ => seq($.kw_fallback, optional(choice($.string, $.kw_off))),
    custom_editor: $ => seq($.kw_customeditor, repeat1($.string)),

    // ---------- Properties（T-012 符号索引的 Properties 来源） ----------
    properties_block: $ => seq(
      $.kw_properties,
      '{',
      repeat($.property_decl),
      '}',
    ),

    // 注：属性名/类型名与状态命令共用同一个 `word` token —— tree-sitter 不允许两个
    // 模式完全相同的 token（会产生词法冲突与 MISSING 伪节点）。Properties 与命令上下文
    // 的区分由 grammar 规则结构 + scanner 的关键字抑制完成，不需要两个同形 token。
    property_decl: $ => seq(
      optional(seq('[', repeat1($.word), ']')),       // [Toggle(_X_ON)] 等 drawer 前缀
      $.word,
      '(',
      $.string,
      ',',
      optional(seq($._prop_type, optional(seq('(', $.number, ',', $.number, ')')))),
      optional(seq(',', choice($.number, $.word))),
      ')',
      optional(seq('=', $.prop_value)),
      optional(seq('{', repeat($.word), '}')),
    ),

    _prop_type: $ => choice($.word, $.dim_type),
    dim_type: $ => /[0-9]+[A-Za-z0-9_]*/,            // 2D / 2DArray / CubeArray …

    prop_value: $ => choice(
      $.string,
      $.number,
      seq('(', choice($.number, $.word), repeat(seq(',', choice($.number, $.word))), ')'),
      seq('{', repeat($.word), '}'),
    ),

    // ---------- 程序块 ----------
    program_hlsl: $ => seq($.kw_hlslprogram, $._hlsl_block, $.kw_endhlsl),
    program_hlsl_include: $ => seq($.kw_hlslinclude, $._hlsl_block, $.kw_endhlsl),
    program_cg: $ => seq($.kw_cgprogram, $._cg_block, $.kw_endcg),
    program_cg_include: $ => seq($.kw_cginclude, $._cg_block, $.kw_endcg),
    program_glsl: $ => seq($.kw_glslprogram, $._glsl_block, $.kw_endglsl),

    // ---------- ShaderLab 层预处理器（extras） ----------
    // 带参数的指令：行内剩余部分必需（extras 里的 comment 会单独词法，不影响）
    preproc_include: $ => seq($.kw_include, $.string),
    preproc_def: $ => seq($.kw_define, $.preproc_rest),
    preproc_undef: $ => seq($.kw_undef, $.preproc_rest),
    preproc_if: $ => seq($.kw_if, $.preproc_rest),
    preproc_ifdef: $ => seq($.kw_ifdef, $.preproc_rest),
    preproc_ifndef: $ => seq($.kw_ifndef, $.preproc_rest),
    preproc_elif: $ => seq($.kw_elif, $.preproc_rest),
    // 无参数指令：结尾唯一
    preproc_else: $ => $.kw_else,
    preproc_endif: $ => $.kw_endif,

    preproc_rest: $ => /[^ \t\n][^\n]*/,

    // ---------- 状态命令（Cull Off / Blend … / Stencil { Ref 255 … }） ----------
    // ShaderLab 状态命令是行导向的，但 newline 不作为 token（否则要为每条规则放行换行，
    // 代价远大于收益）。因此 `Cull Off ZWrite On` 会被并入同一条命令的参数序列，
    // 结构偏粗但零 ERROR —— 对本项目（符号索引、跳转、补全）足够；诊断功能只依赖
    // 真正的语法错误，不依赖命令边界精度。
    // 命令后紧跟 `{` 时归入本命令的内联块（Stencil/CameraRenderType/Fog 等）。
    state_command: $ => prec.right(seq($.word, repeat($.command_arg), optional($._braced_body))),
    _braced_body: $ => seq('{', repeat($.state_command), '}'),
    command_arg: $ => choice($.word, $.number, $.string, '(', ')', ',', '=', '+', '-', '*', '/', '|', '&', '%', '^', '!', '.', ':'),

    word: $ => /[A-Za-z_][A-Za-z0-9_]*/,

    string: $ => /"(?:[^"\\\n]|\\.)*"/,
    number: $ => /[-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?/,

    comment: $ => token(choice(
      seq('//', /[^\n]*/),
      seq('/*', /[\s\S]*?/, '*/'),
    )),
  },
});
