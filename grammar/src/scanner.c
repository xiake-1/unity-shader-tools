/*
 * shaderlab external scanner (T-003)
 *
 * 1) Case-insensitive ShaderLab keywords, produced as named external tokens.
 *    Context sensitivity comes entirely from the parser-supplied valid_symbols:
 *    inside Properties / Stencil{...} a keyword is not a valid token, so the
 *    scanner returns false and the internal lexer produces `word` / `prop_name`.
 *    No case-combination enumeration (the anti-pattern seen in the reference product).
 * 2) Program block bodies (HLSLPROGRAM / HLSLINCLUDE / CGPROGRAM / GLSLPROGRAM up to
 *    their END marker) are consumed as a single hidden external token. The HLSL body is
 *    re-parsed by the server with tree-sitter-hlsl (T-004).
 *
 * No scanner state: block skipping is driven by valid_symbols, so
 * serialize/deserialize are no-ops.
 *
 * NOTE: keep this file ASCII-only. MSVC on a non-UTF8 code page (936) mis-lexes
 * multi-byte comment bytes and breaks the syntax of the surrounding code.
 */

#include <tree_sitter/parser.h>
#include <stdbool.h>
#include <stdint.h>
#include <ctype.h>
#include <string.h>
#include <wctype.h> /* iswspace: clang (macOS) errors on implicit declarations under C99+ */

/* Order must match the externals array in grammar.js exactly. */
typedef enum {
  TOK_HLSL_BLOCK,   /* 0  _hlsl_block */
  TOK_CG_BLOCK,     /* 1  _cg_block   */
  TOK_GLSL_BLOCK,   /* 2  _glsl_block */
  TOK_SHADER,       /* 3 */
  TOK_CATEGORY,     /* 4 */
  TOK_SUBSHADER,    /* 5 */
  TOK_PASS,         /* 6 */
  TOK_TAGS,         /* 7 */
  TOK_PROPERTIES,   /* 8 */
  TOK_NAME,         /* 9 */
  TOK_LOD,          /* 10 */
  TOK_USEPASS,      /* 11 */
  TOK_GRABPASS,     /* 12 */
  TOK_FALLBACK,     /* 13 */
  TOK_CUSTOMEDITOR, /* 14 */
  TOK_HLSLPROGRAM,  /* 15 */
  TOK_HLSLINCLUDE,  /* 16 */
  TOK_ENDHLSL,      /* 17 */
  TOK_CGPROGRAM,    /* 18 */
  TOK_ENDCG,        /* 19 */
  TOK_GLSLPROGRAM,  /* 20 */
  TOK_ENDGLSL,      /* 21 */
  TOK_INCLUDE,      /* 22 */
  TOK_DEFINE,       /* 23 */
  TOK_UNDEF,        /* 24 */
  TOK_IF,           /* 25 */
  TOK_IFDEF,        /* 26 */
  TOK_IFNDEF,       /* 27 */
  TOK_ELIF,         /* 28 */
  TOK_ELSE,         /* 29 */
  TOK_ENDIF,        /* 30 */
  TOK_OFF,          /* 31  only for `Fallback Off` */
  TOK_CGINCLUDE,    /* 32  CGINCLUDE ... ENDCG */
  TOK_COUNT
} TokenId;

static const char *const KEYWORD_TEXT[TOK_COUNT] = {
  0, 0, 0,
  "shader", "category", "subshader", "pass", "tags", "properties",
  "name", "lod", "usepass", "grabpass", "fallback", "customeditor",
  "hlslprogram", "hlslinclude", "endhlsl", "cgprogram", "endcg",
  "glslprogram", "endglsl",
  /* preprocessor keywords live in the table below, not on the word path */
  0, 0, 0, 0, 0, 0, 0, 0, 0,
  "off",
  "cginclude",
};

typedef struct {
  const char *text;
  TokenId token;
} PreprocKeyword;

/* longer words first so prefixes never shadow them */
static const PreprocKeyword PREPROC_KEYWORDS[] = {
  {"include", TOK_INCLUDE},
  {"ifndef",  TOK_IFNDEF},
  {"ifdef",   TOK_IFDEF},
  {"define",  TOK_DEFINE},
  {"undef",   TOK_UNDEF},
  {"endif",   TOK_ENDIF},
  {"elif",    TOK_ELIF},
  {"else",    TOK_ELSE},
  {"if",      TOK_IF},
};
static const size_t PREPROC_KEYWORD_COUNT =
  sizeof(PREPROC_KEYWORDS) / sizeof(PREPROC_KEYWORDS[0]);

void *tree_sitter_shaderlab_external_scanner_create(void) {
  return 0;
}

void tree_sitter_shaderlab_external_scanner_destroy(void *payload) {
  (void)payload;
}

unsigned tree_sitter_shaderlab_external_scanner_serialize(
  void *payload, char *buffer
) {
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_shaderlab_external_scanner_deserialize(
  void *payload, const char *buffer, unsigned length
) {
  (void)payload;
  (void)buffer;
  (void)length;
}

static bool is_word_char(int32_t c) {
  return c != -1 && (isalnum((int)c) != 0 || c == '_');
}

static bool ci_equal(const char *a, const char *b) {
  while (*a && *b) {
    char ca = *a, cb = *b;
    if (ca >= 'A' && ca <= 'Z') ca = (char)(ca + 32);
    if (cb >= 'A' && cb <= 'Z') cb = (char)(cb + 32);
    if (ca != cb) return false;
    a++;
    b++;
  }
  return *a == 0 && *b == 0;
}

/*
 * Consume a whole word case-insensitively and check the trailing boundary.
 * On failure some characters may already have been consumed; that is harmless
 * because the parser restarts lexing at the original position when the external
 * scanner returns false.
 */
static bool match_word(TSLexer *lexer, const char *word) {
  const char *p = word;
  while (*p) {
    int32_t actual = lexer->lookahead;
    char expected = *p;
    if (expected >= 'a' && expected <= 'z') {
      if (actual != (int32_t)expected && actual != (int32_t)(expected - 32)) {
        return false;
      }
    } else if (actual != (int32_t)(unsigned char)expected) {
      return false;
    }
    lexer->advance(lexer, false);
    p++;
  }
  return !is_word_char(lexer->lookahead);
}

/*
 * Consume a program block body, stopping right before its END keyword: at every
 * position that follows a non-word character we mark_end first, then try to match
 * the END keyword. On success the token text is everything up to that mark.
 */
static bool scan_block_content(TSLexer *lexer, const char *endkw, TSSymbol result) {
  int32_t prev = 0;
  while (!lexer->eof(lexer)) {
    if (!is_word_char(prev)) {
      lexer->mark_end(lexer);
      if (match_word(lexer, endkw)) {
        lexer->result_symbol = result;
        return true;
      }
    }
    prev = lexer->lookahead;
    lexer->advance(lexer, false);
  }
  return false;
}

static bool scan(TSLexer *lexer, const bool *valid_symbols) {
  /* ---- 1. program block bodies ---- */
  if (valid_symbols[TOK_HLSL_BLOCK]) {
    return scan_block_content(lexer, "endhlsl", (TSSymbol)TOK_HLSL_BLOCK);
  }
  if (valid_symbols[TOK_CG_BLOCK]) {
    return scan_block_content(lexer, "endcg", (TSSymbol)TOK_CG_BLOCK);
  }
  if (valid_symbols[TOK_GLSL_BLOCK]) {
    return scan_block_content(lexer, "endglsl", (TSSymbol)TOK_GLSL_BLOCK);
  }

  /* ---- 2. skip whitespace ---- */
  while (!lexer->eof(lexer) && iswspace((int)lexer->lookahead)) {
    lexer->advance(lexer, true);
  }
  if (lexer->eof(lexer)) return false;

  /* ---- 3. preprocessor keywords ---- */
  if (lexer->lookahead == '#') {
    bool any = false;
    for (int t = TOK_INCLUDE; t < TOK_COUNT; t++) {
      if (valid_symbols[t]) { any = true; break; }
    }
    if (!any) return false;
    lexer->advance(lexer, false);
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
      lexer->advance(lexer, false);
    }
    char word[16];
    int n = 0;
    while (n < 15 && is_word_char(lexer->lookahead)) {
      word[n++] = (char)lexer->lookahead;
      lexer->advance(lexer, false);
    }
    word[n] = '\0';
    if (is_word_char(lexer->lookahead)) return false;
    for (size_t i = 0; i < PREPROC_KEYWORD_COUNT; i++) {
      const PreprocKeyword *kw = &PREPROC_KEYWORDS[i];
      if (ci_equal(word, kw->text) && valid_symbols[kw->token]) {
        lexer->mark_end(lexer);
        lexer->result_symbol = (TSSymbol)kw->token;
        return true;
      }
    }
    return false;
  }

  /* ---- 4. ShaderLab keywords ---- */
  if (!is_word_char(lexer->lookahead) || isdigit((int)lexer->lookahead)) {
    return false;
  }
  char word[32];
  int n = 0;
  while (n < 31 && is_word_char(lexer->lookahead)) {
    word[n++] = (char)lexer->lookahead;
    lexer->advance(lexer, false);
  }
  word[n] = '\0';
  if (is_word_char(lexer->lookahead)) return false;

  for (int t = TOK_SHADER; t < TOK_COUNT; t++) {
    const char *text = KEYWORD_TEXT[t];
    if (!text) continue;
    if (ci_equal(word, text) && valid_symbols[t]) {
      lexer->mark_end(lexer);
      lexer->result_symbol = (TSSymbol)t;
      return true;
    }
  }
  return false;
}

bool tree_sitter_shaderlab_external_scanner_scan(
  void *payload, TSLexer *lexer, const bool *valid_symbols
) {
  (void)payload;
  return scan(lexer, valid_symbols);
}
