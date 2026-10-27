{
  "targets": [
    {
      "target_name": "shaderlab_binding",
      "dependencies": [
        "<!(node -p \"require('node-addon-api').targets\"):node_addon_api_except"
      ],
      "include_dirs": [
        "src"
      ],
      "sources": [
        "bindings/node/binding.cc",
        "src/parser.c",
        "src/scanner.c"
      ],
      "cflags_c": [
        "-std=c11"
      ],
      "conditions": [
        ["OS==\"win\"", {
          "cflags_c": ["/wd4018", "/wd4244"],
          "defines": ["_CRT_SECURE_NO_WARNINGS"]
        }]
      ]
    }
  ]
}
