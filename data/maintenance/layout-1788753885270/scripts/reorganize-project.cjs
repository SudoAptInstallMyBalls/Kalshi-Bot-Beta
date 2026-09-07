// One-time, bounded source migration. Refuses paths outside this repository.
const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
const mapping = {};
for (const file of walk('agents')) mapping[file] = `src/${file}`;
Object.assign(mapping, {
  'bot/kalshi.js': 'src/exchange/kalshi-client.js',
  'bot/order-manager.js': 'src/execution/order-manager.js',
  'bot/db.js': 'src/storage/analytics-db.js', 'bot/state.js': 'src/storage/bot-state.js',
  'bot/trend.js': 'src/strategy/trend-indicator.js',
});
for (const file of ['binance-ws', 'redstone', 'polymarket']) mapping[`bot/${file}.js`] = `src/market-data/${file}.js`;
for (const [domain, files] of Object.entries({
  execution: ['kalshi-order', 'order-rejection', 'book-execution'],
  risk: ['trading-safety', 'trading-math'],
  ml: ['ml-pipeline', 'ml-write-buffer', 'training-split', 'regularized-logistic'],
  research: ['history-replay', 'market-history', 'research-data'],
  storage: ['research-telemetry'],
})) for (const file of files) mapping[`lib/${file}.js`] = `src/${domain}/${file}.js`;
for (const file of ['research-config', 'research-demo-active', 'research-policy']) mapping[`${file}.json`] = `config/research/${file}.json`;
for (const file of fs.readdirSync(root).filter(f => f.endsWith('.md') && f !== 'README.md')) mapping[file] = `docs/${file}`;
mapping['backtest/backtest.js'] = 'scripts/synthetic-backtest.js';
mapping['backtest/FINDINGS.md'] = 'docs/archive/SYNTHETIC_FINDINGS.md';
const sourceFiles = [...walk('agents'), ...walk('bot'), ...walk('lib'), ...walk('scripts'), ...walk('test'), ...walk('backtest'), ...walk('public'), ...fs.readdirSync(root).filter(f => /\.(js|json|md)$/.test(f))];
const originals = new Map(sourceFiles.map(f => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
const backup = `data/maintenance/layout-${Date.now()}`;
for (const [file, content] of originals) {
  const dest = path.join(root, backup, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, content);
}
const alias = file => '#src/' + file.slice(4).replace(/\.js$/, '');
const literalMap = { ...mapping, 'agents/': 'src/agents/', 'bot/': 'src/', 'lib/': 'src/' };
// Longer full-file references first; do not modify historic data artifacts.
const literals = Object.keys(mapping).sort((a,b)=>b.length-a.length);
for (const [old, original] of originals) {
  const dest = mapping[old] || old;
  let content = original;
  if (/\.(js|cjs)$/.test(old)) {
    content = content.replace(/require\((['"])(\.[^'"]+)\1\)/g, (match, quote, spec) => {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(old), spec));
      target = [target, target+'.js', target+'/index.js'].find(t => originals.has(t));
      if (!target) return match;
      const moved = mapping[target] || target;
      if (moved.startsWith('src/')) return `require('${alias(moved)}')`;
      let relative = path.posix.relative(path.posix.dirname(dest), moved);
      if (!relative.startsWith('.')) relative = './'+relative;
      return `require('${relative}')`;
    });
  }
  // Exact quoted references (source hashes, research config filenames).
  for (const file of literals) content = content.split(`'${file}'`).join(`'${mapping[file]}'`).split(`"${file}"`).join(`"${mapping[file]}"`);
  if (old.endsWith('.md')) for (const file of literals) content = content.split(file).join(mapping[file]);
  if (dest.startsWith('src/')) {
    content = content.replace(/path\.join\(__dirname,\s*'\.\.',\s*'data'\)/g, "require('#src/config/paths').dataDir");
    content = content.replace(/path\.join\(__dirname,\s*'\.\.\/data'\)/g, "require('#src/config/paths').dataDir");
  }
  const full = path.resolve(root, dest);
  if (!full.startsWith(root + path.sep)) throw Error('Outside workspace: '+dest);
  fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content);
}
for (const old of Object.keys(mapping)) {
  const full = path.resolve(root, old);
  if (!full.startsWith(root + path.sep)) throw Error('Outside workspace');
  fs.unlinkSync(full);
}
for (const dir of ['agents', 'bot', 'lib', 'backtest']) {
  function prune(full) { for (const e of fs.readdirSync(full, {withFileTypes:true})) if(e.isDirectory()) prune(path.join(full,e.name)); if(!fs.readdirSync(full).length) fs.rmdirSync(full); }
  prune(path.join(root,dir));
}
const pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json')));
pkg.imports = { '#src/*': './src/*.js' };
pkg.engines = { node: '>=24' };
pkg.scripts['backtest:synthetic'] = 'node scripts/synthetic-backtest.js';
fs.writeFileSync(path.join(root,'package.json'), JSON.stringify(pkg,null,2)+'\n');
fs.writeFileSync(path.join(root, backup, 'migration.json'),JSON.stringify({mapping,backup},null,2));
console.log(JSON.stringify({moved:Object.keys(mapping).length,backup}));
