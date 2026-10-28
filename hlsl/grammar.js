const CPP = require("tree-sitter-cpp/grammar")

module.exports = grammar(CPP, {
    name: 'hlsl',

    conflicts: ($, original) => original.concat([
        [$.function_declarator],
        [$.macro_member],
        [$._declarator, $.type_specifier, $.macro_member],
        [$.type_specifier, $.macro_member],
        [$.sized_type_specifier, $.macro_member],
        [$._declarator, $.macro_member],
        [$.expression, $.macro_member],
        // T-034 文件作用域/语句级裸宏调用（macro_statement）与 cpp 声明形态的重叠；
        // macro_bare 是字面 token 白名单，冲突面小，只保留与 macro_statement 的重叠声明。
        [$._declarator, $.type_specifier, $.expression, $.macro_statement],
        [$.expression, $.macro_statement],
        [$.type_specifier, $.macro_statement],
        [$._declarator, $.macro_statement],
        [$.type_specifier, $.expression, $.macro_statement],
        [$.sized_type_specifier, $.macro_statement],
        [$._class_name, $.macro_statement],
        [$.macro_statement],
        [$.macro_bare],
        [$.macro_statement, $.macro_bare],
    ]),

    rules: {
        // （_top_level_item 的覆写在下方「本地补丁」段）

        function_definition: ($, original) => seq(
            optional(
                $.hlsl_attribute,
            )
            , original
        ),
        function_declarator: ($, original) => seq(
            original,
            optional($.semantics)
        ),

        declaration: $ => seq(
            $._declaration_specifiers,
            commaSep1(field('declarator', choice(
                seq($._declarator, optional(alias(seq(':', $.expression), $.semantics))),
                $.init_declarator
            ))),
            ';'
        ),

        _declaration_modifiers: ($, original) => choice(
            'in',
            'out',
            'inout',
            $.qualifiers,
            original),


        parameter_declaration: ($, original) =>
            seq(
                original,
                optional($.semantics),
            ),

        semantics: $ => seq(":", $.identifier),

        _non_case_statement: ($, original) => choice(
            $.discard_statement,
            $.cbuffer_specifier,
            $.macro_statement,
            $.macro_bare,
            original,
        ),

        if_statement: ($, original) => seq(optional($.hlsl_attribute), original),

        discard_statement: _ => seq('discard', ';'),
        qualifiers: _ => choice(
            'precise',
            'shared',
            'groupshared',
            'uniform',
            'row_major',
            'column_major',
            'globallycoherent',
            'centroid',
            'noperspective',
            'nointerpolation',
            'sample',
            'linear',
            'snorm',
            'unorm',
            'point',
            'line',
            'triangleadj',
            'lineadj',
            'triangle',
        ),

        cbuffer_specifier: $ => prec.right(seq(
            'cbuffer',
            optional($.attribute_declaration),
            choice(
                field('name', $._class_name),
                seq(
                    optional(field('name', $._class_name)),
                    optional($.virtual_specifier),
                    optional($.base_class_clause),
                    field('body', $.field_declaration_list)
                )
            )
        )),

        hlsl_attribute: $ => seq('[',
            $.expression,
            ']'),

        for_statement: ($, original) => seq(optional($.hlsl_attribute), original),

        // ---- 本地补丁（Unity CGIncludes，2026-10-28）----
        // struct 体内的「裸宏成员」：UNITY_VERTEX_INPUT_INSTANCE_ID / UNITY_VERTEX_OUTPUT_STEREO
        // 等（无类型、无分号，或宏调用形态）。上游 0.2.0 的 field_declaration 必须有 declarator
        // 和分号，一个裸宏就把 struct 收尾 `};` 变 ERROR，并级联吞掉整文件（appdata_base、
        // UnityObjectToWorldNormal 等声明全部丢失）。
        // 挂在 cpp 的 _field_declaration_list_item 扩展点上；prec.dynamic(-1) 让
        // `MACRO();` 之类与成员函数声明形态重叠时优先原解释，只有无分号形态走这里。
        _field_declaration_list_item: ($, original) => choice(
            original,
            $.macro_member,
        ),

        // 文件作用域裸宏调用（T-034，2026-10-28 第二轮补丁）：
        // `UNITY_INSTANCING_BUFFER_START(Props)` / `UNITY_INSTANCING_BUFFER_END(Props)` 这类
        // **不带分号**的宏调用在 cpp 顶层会被当函数原型，于是 tree-sitter 插一个 MISSING `;`
        // （实测语料 219 处 / 24 文件，是 ERROR 模式第一名）。带 primitive 参数的形态
        // （`UNITY_DEFINE_INSTANCED_PROP(float, x)`）仍不处理——与 cpp 顶层文法冲突面过大，
        // 见 docs/decisions/0007 已知限制与 errorExemption 豁免表。
        // prec.dynamic(-1)：`MACRO(x);` 有分号时仍走原 declaration/call_expression 解释
        // （symbolIndex 的宏声明识别依赖那两种形态），只有无分号形态落到这里。
        _top_level_item: ($, original) => choice(
            original,
            $.macro_statement,
            $.macro_bare,
        ),

        macro_statement: $ => prec.dynamic(-1, seq(
            choice($.identifier, $._type_identifier),
            '(',
            // 实参允许任意 expression：`UNITY_LIGHT_ATTENUATION(atten, i, s.posWorld)`、
            // `TRANSFER_SHADOW_CASTER_NOPOS(o, output.pos)` 这类带成员访问的宏调用不带分号，
            // 只列 identifier/number 会把它们漏掉（语料实测 4 处）。
            optional(commaSep1(choice($.identifier, $._type_identifier, $.expression))),
            ')',
        )),

        // 控制流提示宏（`UNITY_BRANCH` / `UNITY_FLATTEN` / `FLATTEN` / `allow_uav_condition`）
        // 写成裸标识符独占一行、紧接 `if`/`for`：cpp 把裸标识符当声明开头 → MISSING `;`
        // （语料实测 215 处 / 23 文件，AreaLighting.hlsl、UnityStandardCore.cginc 等）。
        // **用字面 token 而不是任意 identifier**：任意标识符形态与 cpp 的
        // type_specifier / _class_name / concatenated_string 等冲突面过大（generate 直接失败），
        // 而这几个宏本就是固定词表；命中后成为独立 token，不再与 identifier 争抢。
        macro_bare: $ => prec.dynamic(-1, choice(
            'UNITY_BRANCH',
            'UNITY_FLATTEN',
            'FLATTEN',
            'allow_uav_condition',
            // Unity CBUFFER 宏对的下半截：`CBUFFER_START(...) 字段… CBUFFER_END`
            // 收尾是裸标识符不带分号（test/unit/hlsl.test.ts 的 CBUFFER 用例）
            'CBUFFER_END',
        )),

        // （文件作用域带 primitive 参数的裸宏调用仍不处理：见 docs 已知限制）

        macro_member: $ => prec.dynamic(-1, seq(
            choice($.identifier, $._type_identifier),
            optional(seq('(', commaSep(choice($.expression, $.primitive_type, $._type_identifier)), ')')),
        )),

        // 跨行宏（`\` 续行）体内允许 /* */ 块注释：上游 preproc_arg 的字符类遇到 `/*` 即截断，
        // 导致 UnityPBSLighting.cginc / UnityLegacyTextureStack.cginc 等整段宏体被当代码解析。
        preproc_arg: _ => token(prec(-1, /\S([^/\n]|\/[^*]|\/\*([^*]|\*+[^*/])*\*+\/|\\\r?\n)*/)),

    }
});

function commaSep(rule) {
    return optional(seq(rule, repeat(seq(',', rule))))
}

function commaSep1(rule) {
    return seq(rule, repeat(seq(',', rule)))
}
