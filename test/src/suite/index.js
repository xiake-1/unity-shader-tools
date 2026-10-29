// 极简测试运行器：不引入 mocha，顺序执行同目录下的用例模块
const path = require('path');

async function run() {
  // definition.test.js 必须在前：extension.test.js 的崩溃用例会永久杀掉 server
  const cases = [
    require('./definition.test.js'),
    require('./completion.test.js'),
    require('./rename.test.js'),
    require('./diagnostics.test.js'),
    require('./typeDiagnostics.test.js'),
    require('./formatting.test.js'),
    require('./deadBranch.test.js'),
    require('./shaderNames.test.js'),
    require('./languageId.test.js'),
    require('./extension.test.js'),
  ];
  // 只跑名字包含该子串的用例（崩溃用例很慢，迭代时用它过滤）
  const filter = process.env.UNITYSHADER_TEST_FILTER || '';
  const failures = [];
  for (const mod of cases) {
    for (const [name, fn] of Object.entries(mod.tests)) {
      if (filter && !name.includes(filter)) {
        console.log(`  – ${name}（UNITYSHADER_TEST_FILTER 过滤）`);
        continue;
      }
      try {
        await fn();
        console.log(`  ✓ ${name}`);
      } catch (err) {
        failures.push({ name, err });
        console.error(`  ✗ ${name}: ${err && err.message}`);
      }
    }
  }
  if (failures.length) {
    throw new Error(`${failures.length} 个集成用例失败：${failures.map((f) => f.name).join(', ')}`);
  }
  console.log('集成测试全部通过');
}

module.exports = { run };
