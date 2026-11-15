import {mkdir,readFile,writeFile,rename,open,unlink,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {cycleStages} from './editorial-cycle.mjs';

// Private single-host worker journal. Atomic rename and per-job exclusive lock protect parallel ticks.
// A stale lock on a public write is UNKNOWN, never a licence to send again.
export function fileCycleStore(directory,{leaseMs=180000}={}) {
 const base=resolve(directory);
 const path=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('CYCLE_ID_INVALID');return join(base,id+'.json');};
 const save=async(id,value)=>{const temp=path(id)+'.'+randomUUID()+'.new';await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});await rename(temp,path(id));};
 const load=async id=>JSON.parse(await readFile(path(id),'utf8'));
 const lockPath=id=>path(id)+'.lock';
 return {
  load,
  async create(policy) {
   if(!/^UC[\w-]{22}$/.test(policy.sourceChannelId??'')||!/^UC[\w-]{22}$/.test(policy.ownChannelId??'')
     ||!Number.isFinite(policy.scoreThreshold)||policy.scoreThreshold<0||policy.scoreThreshold>100
     ||typeof policy.publishApproved!=='boolean')throw Error('CYCLE_POLICY_INVALID');
   await mkdir(base,{recursive:true,mode:0o700});const id=randomUUID();
   const job={id,state:'queued',stageIndex:0,policy,artifacts:{},events:[],createdAt:new Date().toISOString()};
   await save(id,job);return job;
  },
  async claim(id,token,now) {
   let handle;
   try {handle=await open(lockPath(id),'wx',0o600);} catch(error) {
    if(error.code!=='EEXIST')throw error;
    const age=now-(await stat(lockPath(id))).mtimeMs;
    if(age<leaseMs)return null;
    // Do not unlink a possibly renewed owner's lock. Recovery is explicit and offline.
    return null;
   }
   await handle.close();
   try {
    const job=await load(id);
    if(!['queued','waiting'].includes(job.state)||job.retryAt>now){await unlink(lockPath(id));return null;}
    job.state='running';job.lease={token,expiresAt:now+leaseMs};
    job.events.push({at:new Date(now).toISOString(),stage:cycleStages[job.stageIndex],state:'running'});
    await save(id,job);return {job,token};
   }catch(error){await unlink(lockPath(id)).catch(()=>{});throw error;}
  },
  async finish(id,token,patch) {
   const job=await load(id);if(job.lease?.token!==token)throw Error('CYCLE_LEASE_LOST');
   const stage=cycleStages[job.stageIndex];Object.assign(job,patch);delete job.lease;
   job.events.push({at:new Date().toISOString(),stage,state:patch.state,code:patch.code??null});
   await save(id,job);await unlink(lockPath(id));
  },
  async recover(id) {
   const job=await load(id), now=Date.now();
   if(job.state!=='running'||!job.lease||job.lease.expiresAt>now)throw Error('CYCLE_NOT_RECOVERABLE');
   const stage=cycleStages[job.stageIndex];
   // Recovering a crashed read is safe. A crashed upload/comment requires reconciliation.
   job.state=['upload','comment'].includes(stage)?'unknown':'queued';
   job.events.push({at:new Date(now).toISOString(),stage,state:job.state,code:'WORKER_INTERRUPTED'});
   delete job.lease;await save(id,job);await unlink(lockPath(id));return job;
  },
 };
}
