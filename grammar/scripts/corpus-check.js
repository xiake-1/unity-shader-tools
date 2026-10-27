// ?????????????????????????shader/hlsl/cginc?????? ERROR/MISSING ??????????// ???: node scripts/corpus-check.js [rootDir]
const fs = require('fs');
const path = require('path');
const Parser = require('tree-sitter');
const grammar = require('../bindings/node');

const root = process.argv[2] || 'D:/Work/Unity/ShaderStudy/Assets';
const parser = new Parser();
parser.setLanguage(grammar);

const files = [];
(function walkDir(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walkDir(f);
    else if (/\.(shader|hlsl|cginc|hlslinc)$/i.test(e.name)) files.push(f);
  }
})(root);

function collect(node, acc) {
  if (node.type === 'ERROR' || node.type === 'MISSING') acc.push(node.type);
  for (const c of node.children) collect(c, acc);
  return acc;
}

let bad = 0;
const details = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const tree = parser.parse(src);
  const errs = collect(tree.rootNode, []);
  if (errs.length) {
    bad++;
    details.push(`${path.relative(root, f)}: ${errs.length}`);
  }
}
details.forEach((d) => console.log('  ' + d));
console.log(
  `files=${files.length} withError=${bad} pct=${((100 * bad) / files.length).toFixed(1)}%`
);
