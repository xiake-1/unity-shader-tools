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

        _non_case_statement: ($, original) => choice($.discard_statement, $.cbuffer_specifier, original),

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

        // （文件作用域裸宏调用暂不处理：与 cpp 顶层文法冲突面过大，见 docs 已知限制）
        _top_level_item: (_, original) => original,

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
