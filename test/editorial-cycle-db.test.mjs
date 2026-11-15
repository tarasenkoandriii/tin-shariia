import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {dbCycleStore} from '../src/automation/db-cycle-store.mjs';
const policy={sourceChannelId:'UC'+'a'.repeat(22),ownChannelId:'UC'+'b'.repeat(22),scoreThreshold:75,publishApproved:false};

test('database cycle lease fences stale workers and preserves a published release',async()=>{
 const db=new PGlite();
 try {
  for(const name of ['0000_editorial_import','0001_editorial_access','0029_editorial_cycles'])await db.exec(await readFile(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));
  const {rows:[member]}=await db.query("INSERT INTO members(clerk_user_id,email) VALUES('cycle-admin','admin@example.test') RETURNING id");
  await db.query("INSERT INTO member_roles(member_id,role) VALUES($1,'admin')",[member.id]);
  const store=dbCycleStore(db,'cycle-admin'),job=await store.create(policy);
  const token='11111111-1111-4111-8111-111111111111';
  assert.ok(await store.claim(job.id,token,Date.now()));
  assert.equal(await store.claim(job.id,'22222222-2222-4222-8222-222222222222',Date.now()),null);
  await store.finish(job.id,token,{state:'queued',stageIndex:8,releaseState:'published',youtubeId:'TBBj5PBD2rk'});
  await assert.rejects(store.finish(job.id,token,{state:'blocked'}),/LEASE_LOST/);
  const next='33333333-3333-4333-8333-333333333333';await store.claim(job.id,next,Date.now());
  await db.query("UPDATE editorial_cycles SET lease_until=now()-interval '1 minute' WHERE id=$1",[job.id]);
  assert.equal(await store.claim(job.id,token,Date.now()),null);
  const final=await store.load(job.id);assert.equal(final.state,'completed');assert.equal(final.releaseState,'published');assert.equal(final.promotionState,'unknown');
  await assert.rejects(store.finish(job.id,next,{state:'queued'}),/LEASE_LOST/);
  assert.equal(final.events[1].stage,'discover');
 }finally{await db.close();}
});
test('cycle creation requires an active admin',async()=>{
 const db=new PGlite();
 try{
  for(const name of ['0000_editorial_import','0001_editorial_access','0029_editorial_cycles'])await db.exec(await readFile(new URL('../drizzle/'+name+'.sql',import.meta.url),'utf8'));
  const store=dbCycleStore(db,'unknown');await assert.rejects(store.create(policy),/FORBIDDEN/);
 }finally{await db.close();}
});
