{
  "targets": [
    {
      "target_name": "ply_reader",
      "sources": [
        "ply-reader.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS"
      ],
      "conditions": [
        [
          "OS==\"win\"",
          {
            "msvs_settings": {
              "VCCLCompilerTool": {
                "Optimization": "3",
                "EnableFunctionLevelLinking": "true",
                "AdditionalOptions": [
                  "/std:c++17",
                  "/O2"
                ]
              }
            }
          }
        ],
        [
          "OS==\"mac\"",
          {
            "xcode_settings": {
              "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
              "GCC_OPTIMIZATION_LEVEL": "3"
            }
          }
        ]
      ]
    }
  ]
}
