import {runChildProcess,runningProcesses} from '../../packages/adapter-utils/src/server-utils.ts';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
const cwd=await fs.mkdtemp(tmpdir()+'/paperclip-memory-probe-');
const wrapper=fileURLToPath(new URL('./bwrap-memory',import.meta.url));
async function probe(name:string,code:string,timeoutSec=10,cancel=false,extraEnv:any={}) {
 let output=''; let cgroup:string|undefined;
 const r=await runChildProcess('fac760-'+name,'/usr/bin/python3',['-c',code],{cwd,env:{XDG_RUNTIME_DIR:'/run/user/1000',...extraEnv},timeoutSec,graceSec:1,
 localProcessSandbox:{workspaceDir:cwd,filesystemScope:'workspace',command:wrapper},
 onLog:async(stream,chunk)=>{if(stream==='stdout'){output+=chunk; const m=output.match(/CGROUP=(.+)\n/);if(m&&!cgroup){cgroup=m[1]; assert.match(cgroup,/paperclip-workers.slice/);
 assert.equal((await fs.readFile('/sys/fs/cgroup'+cgroup+'/memory.max','utf8')).trim(),'4294967296');
 if(cancel){const p=runningProcesses.get('fac760-'+name);if(p?.processGroupId)process.kill(-p.processGroupId,'SIGTERM');}
 }}}
 });
 console.log(JSON.stringify({name,exitCode:r.exitCode,signal:r.signal,timedOut:r.timedOut,stdout:r.stdout,stderr:r.stderr,cgroup}));
 if(cgroup){let present=true;try{await fs.access('/sys/fs/cgroup'+cgroup+'/cgroup.procs');}catch{present=false;}if(present)assert.equal((await fs.readFile('/sys/fs/cgroup'+cgroup+'/cgroup.procs','utf8')).trim(),'');}
 return r;
}
const base="import os,sys,time\nprint('CGROUP='+open('/proc/self/cgroup').read().strip().split('::')[1],flush=True)\n";
const a=await probe('stdio',base+"print('exact-out'); print('exact-err',file=sys.stderr); sys.exit(17)");
assert.equal(a.exitCode,17);assert.match(a.stdout,/exact-out/);assert.equal(a.stderr,'exact-err\n');
const timeout=await probe('timeout',base+"pid=os.fork()\nif pid==0: time.sleep(60)\nelse: time.sleep(60)",2);
assert.equal(timeout.timedOut,true);
const cancel=await probe('cancel',base+"pid=os.fork()\nif pid==0: time.sleep(60)\nelse: time.sleep(60)",10,true);
assert.notEqual(cancel.exitCode,0);
const fail=await probe('no-bus',"print('must-not-run')",5,false,{XDG_RUNTIME_DIR:'/tmp/fac760-no-bus',DBUS_SESSION_BUS_ADDRESS:'unix:path=/tmp/fac760-no-bus/bus'});
assert.notEqual(fail.exitCode,0);assert.equal(fail.stdout,'');
console.log('PASS actual adapter subprocess wrapper stdio, exit, timeout, cancellation, descendants, fail-closed');

await fs.rm(cwd,{recursive:true,force:true});
