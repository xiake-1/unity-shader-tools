// 诊断：打印指定文件的 ERROR/MISSING 位置及其源码上下文
const fs = require('fs');
const Parser = require('tree-sitter');
const grammar = require('../bindings/node');
const parser = new Parser();
parser.setLanguage(grammar);

const file = process.argv[2];
const src = fs.readFileSync(file, 'utf8');
const lines = src.split(/\r?\n/);
const tree = parser.parse(src);

function collect(node, acc) {
  if (node.type === 'ERROR' || node.type === 'MISSING') acc.push(node);
  for (const c of node.children) collect(c, acc);
  return acc;
}

for (const n of collect(tree.rootNode, [])) {
  const r = n.startPosition.row;
  console.log(`${n.type} @ line ${r + 1} col ${n.startPosition.column}`);
  for (let i = Math.max(0, r - 1); i <= Math.min(lines.length - 1, r + 1); i++) {
    console.log(`   ${i + 1}| ${lines[i]}`);
  }
  console.log('');
}
