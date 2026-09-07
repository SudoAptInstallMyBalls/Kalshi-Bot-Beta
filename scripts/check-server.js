// Starts an isolated, idle dashboard on a temporary port. Never starts trading.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const {root}=require('#src/config/paths');
async function main(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'kalshibot-server-check-'));
  const envFile=path.join(directory,'.env');fs.writeFileSync(envFile,'');
  const reservation=net.createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:directory,windowsHide:true,
    env:{...process.env,PORT:String(port),HOST:'127.0.0.1',BOT_ENV_FILE:envFile,BOT_DATA_DIR:directory,
      BOT_CONTROL_TOKEN:'isolated-check',KALSHI_API_BASE:'https://external-api.demo.kalshi.co',KALSHI_API_KEY:'',KALSHI_PRIVATE_KEY_BASE64:''},stdio:['ignore','pipe','pipe']});
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Server startup timed out')),10000);
      child.stdout.on('data',chunk=>{if(chunk.toString().includes('Bot is IDLE')){clearTimeout(timer);resolve();}});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',code=>{clearTimeout(timer);reject(Error('Server exited during startup: '+code));});
    });
    const base=`http://127.0.0.1:${port}`;
    const health=await(await fetch(base+'/api/health')).json();assert.equal(health.botRunning,false);
    assert.equal((await fetch(base+'/api/bot/status')).status,401);
    const status=await(await fetch(base+'/api/bot/status',{headers:{Authorization:'Bearer isolated-check'}})).json();
    assert.ok(status);
    const html=await(await fetch(base+'/')).text();assert.match(html,/type="module" src="js\/app.js"/);
    for(const file of ['app','api','chart','dom','state','views'])assert.equal((await fetch(`${base}/js/${file}.js`)).status,200);
    console.log('Server: isolated idle startup, health, authentication and dashboard assets passed from a different cwd.');
  }finally{
    if(child.exitCode===null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();await closed;}
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
