const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const { root, dataDir, publicDir } = require('#src/config/paths');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]);
}
test('all literal local imports resolve without executing the trading application', () => {
  const files = ['src','scripts','test'].flatMap(dir=>walk(path.join(root,dir))).filter(f=>f.endsWith('.js'));
  for (const file of files) {
    const localRequire = createRequire(file);
    for (const [,spec] of fs.readFileSync(file,'utf8').matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (spec.startsWith('.') || spec.startsWith('#src/')) assert.doesNotThrow(()=>localRequire.resolve(spec), `${file}: ${spec}`);
    }
  }
});
test('default storage, research config and frozen policy remain rooted at the repository', () => {
  assert.equal(dataDir, path.join(root,'data'));
  assert.equal(publicDir, path.join(root,'public'));
  const {parseArgs}=require('../scripts/replay-history');
  const options=parseArgs([]);
  assert.equal(options.history,path.join(dataDir,'market-history/history.sqlite'));
  const config=JSON.parse(fs.readFileSync(options.config));
  const policy=JSON.parse(fs.readFileSync(path.join(root,'config/research/research-policy.json')));
  const hash=require('node:crypto').createHash('sha256').update(JSON.stringify(config)).digest('hex');
  assert.equal(hash,policy.configSha256);
});
test('extracted control authentication still rejects missing and incorrect credentials', () => {
  const saved=process.env.BOT_CONTROL_TOKEN;
  process.env.BOT_CONTROL_TOKEN='test-only-token';
  try {
    const auth=require('#src/server/auth').createAuth(3334);
    let code, passed=false;
    const res={status(n){code=n;return this;},json(){}};
    auth.requireControlAuth({get:()=>''},res,()=>{passed=true;});
    assert.equal(code,401);assert.equal(passed,false);
    auth.requireControlAuth({get:k=>k==='authorization'?'Bearer test-only-token':''},res,()=>{passed=true;});
    assert.equal(passed,true);
    assert.equal(auth.isAllowedOrigin('https://untrusted.invalid'),false);
  } finally {if(saved===undefined)delete process.env.BOT_CONTROL_TOKEN;else process.env.BOT_CONTROL_TOKEN=saved;}
});
