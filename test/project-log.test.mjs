import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {loadProjectLog,logFilters,logLevel} from '../src/db/project-log.mjs';
test('validates dates and filters; unknown outcome needs attention',()=>{
 assert.deepEqual(logFilters({process:'sql',from:'2026-02-30',to:'2026-11-14',page:'-10',q:' x '}),{process:'',level:'',q:'x',from:'',to:'2026-11-14',page:1});
 assert.equal(logLevel('unknown'),'warning');assert.equal(logLevel('failed'),'error');
});
test('journal queries migrated database, isolates admins, filters and sanitizes',async()=>{
 const db=new PGlite();try{
 const journal=JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json',import.meta.url),'utf8'));
 for(const {tag} of journal.entries)await db.exec(await readFile(new URL('../drizzle/'+tag+'.sql',import.meta.url),'utf8'));
 const {rows:[admin]}=await db.query("INSERT INTO members(clerk_user_id,email) VALUES('admin','admin@example.test') RETURNING id");
 await db.query("INSERT INTO member_roles VALUES($1,'admin')",[admin.id]);
 const {rows:[viewer]}=await db.query("INSERT INTO members(clerk_user_id,email) VALUES('author','author@example.test') RETURNING id");
 await db.query("INSERT INTO member_roles VALUES($1,'author')",[viewer.id]);
 await assert.rejects(loadProjectLog(db,'author'),/FORBIDDEN/);
 await assert.rejects(loadProjectLog(db,null),/FORBIDDEN/);
 const {rows:[video]}=await db.query("INSERT INTO videos(youtube_id) VALUES('Yzwu8NXkB5s') RETURNING id");
 await db.query("INSERT INTO captions_import_jobs(video_id,status,error_code,updated_at) VALUES($1,'failed','SECRET https://bad.test/?token=private','2026-11-13T22:30:00Z')",[video.id]);
 const all=await loadProjectLog(db,'admin');assert.equal(all.total,1);assert.equal(all.errors,1);assert.equal(all.items[0].error_code,null);assert.equal(all.items[0].message,'Помилка');assert.equal(all.items[0].linked_video_id,video.id);
 assert.equal((await loadProjectLog(db,'admin',{from:'2026-11-14',to:'2026-11-14',process:'captions',level:'error'})).total,1,'dates use Kyiv midnight');
 assert.equal((await loadProjectLog(db,'admin',{to:'2026-11-13'})).total,0);
 assert.equal((await loadProjectLog(db,'admin',{process:'grok'})).total,0);
 assert.equal((await loadProjectLog(db,'admin',{q:'Yzwu8NXkB5s'})).total,1);
 assert.equal((await loadProjectLog(db,'admin',{q:"' OR 1=1 --"})).total,0);
 assert.equal((await loadProjectLog(db,'admin',{page:'2'})).items.length,0);
 }finally{await db.close();}
});
