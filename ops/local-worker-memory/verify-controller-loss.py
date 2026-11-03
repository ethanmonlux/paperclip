import subprocess,os,signal,time,json,pathlib,sys
wrapper=str(pathlib.Path(__file__).with_name('bwrap-memory'))
log=pathlib.Path('/tmp/fac760-parent-loss.log')
driver="""import subprocess,sys,time
p=subprocess.Popen([sys.argv[1],'--ro-bind','/','/','--unshare-pid','--proc','/proc','--die-with-parent','/usr/bin/python3','-c',"import time; print(open('/proc/self/cgroup').read().strip().split('::')[1],flush=True); time.sleep(60)"])
p.wait()
"""
with log.open('w') as out:
 p=subprocess.Popen(['/usr/bin/python3','-c',driver,wrapper],stdout=out,stderr=out,env={**os.environ,'XDG_RUNTIME_DIR':'/run/user/1000'})
 path=None
 for _ in range(100):
  s=log.read_text()
  if '/user.slice/' in s: path=s.strip().splitlines()[0];break
  time.sleep(.05)
 if not path: raise Exception(log.read_text())
 os.kill(p.pid,signal.SIGKILL);p.wait()
 time.sleep(.5)
 cg=pathlib.Path('/sys/fs/cgroup'+path)
 procs=(cg/'cgroup.procs').read_text().strip() if cg.exists() else ''
 print(json.dumps({'controllerKilled':p.pid,'workerCgroup':path,'remainingPids':procs}))
 if procs:
  subprocess.run(['systemctl','--user','stop',path.split('/')[-1]],env={**os.environ,'XDG_RUNTIME_DIR':'/run/user/1000'},check=True)
 print('cleaned',not cg.exists() or not (cg/'cgroup.procs').read_text().strip())
 assert not procs, 'Worker survived controller loss (test scope cleaned)'
